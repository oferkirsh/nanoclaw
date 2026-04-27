import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  updateTask,
  upsertCalendarEvent,
} from './db.js';
import {
  enrichCalendarEvent,
  resolveVenueAddress,
} from './transport-enricher.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For family_screentime
    member?: string;
    requestId?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For calendar_event_created
    id?: string;
    title?: string;
    start_time?: string;
    end_time?: string;
    person?: string;
    calendar_id?: string;
    address?: string;
    // For smartschool_refresh
    requestedBy?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'family_screentime': {
      const member = data.member || 'noam kirshenbaum';
      const requestId = data.requestId;
      if (!requestId) {
        logger.warn('family_screentime missing requestId');
        break;
      }

      // Resolve script path relative to this file (src/ipc.ts → scripts/family-screentime.sh)
      const scriptDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'scripts',
      );
      const scriptPath = path.join(scriptDir, 'family-screentime.sh');

      if (!fs.existsSync(scriptPath)) {
        logger.error({ scriptPath }, 'family-screentime.sh not found');
        break;
      }

      // Run the host-side script and write the result back
      const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(responseDir, { recursive: true });
      const responsePath = path.join(responseDir, `${requestId}.json`);

      execFile(
        'bash',
        [scriptPath, member],
        { timeout: 30_000 },
        (err, stdout, stderr) => {
          let responseData: object;
          if (err) {
            logger.error({ err, stderr }, 'family-screentime.sh failed');
            responseData = { requestId, error: stderr || err.message };
          } else {
            try {
              responseData = { requestId, result: JSON.parse(stdout) };
            } catch {
              responseData = { requestId, result: stdout.trim() };
            }
          }
          const tempPath = `${responsePath}.tmp`;
          fs.writeFileSync(tempPath, JSON.stringify(responseData, null, 2));
          fs.renameSync(tempPath, responsePath);
          logger.info(
            { requestId, member },
            'Family screentime response written',
          );
        },
      );
      break;
    }

    case 'calendar_event_created': {
      if (
        data.id &&
        data.title &&
        data.start_time &&
        data.person &&
        data.calendar_id
      ) {
        const person = data.person as 'ori' | 'noam' | 'omer' | 'family';
        const now = new Date().toISOString();
        let resolvedAddress = data.address ?? null;

        // If address looks like a venue name (no digits → likely not a street address),
        // attempt geocoding. If it's already a street address, use it directly.
        if (resolvedAddress && !/\d/.test(resolvedAddress)) {
          const geocoded = await resolveVenueAddress(
            resolvedAddress,
            data.title,
            data.start_time.slice(0, 10),
            deps.sendMessage,
          );
          resolvedAddress = geocoded;
        }

        upsertCalendarEvent({
          id: data.id,
          title: data.title,
          start_time: data.start_time,
          end_time: data.end_time ?? null,
          person,
          calendar_id: data.calendar_id,
          color_synced_at: null,
          created_at: now,
          address: resolvedAddress,
          walk_minutes: null,
          distance_km: null,
          origin: null,
          transport_mode: null,
          ride_alert_sent: 0,
        });

        logger.info(
          { eventId: data.id, title: data.title, address: resolvedAddress },
          'Calendar event stored via IPC',
        );

        // Trigger transport enrichment async — don't block IPC processing
        if (resolvedAddress) {
          enrichCalendarEvent(data.id, deps.sendMessage).catch((err) =>
            logger.error(
              { err, eventId: data.id },
              'Transport enrichment failed',
            ),
          );
        }
      } else {
        logger.warn({ data }, 'calendar_event_created missing required fields');
      }
      break;
    }

    case 'classroom_refresh': {
      // Same shape as smartschool_refresh — any group can request, main does it.
      const mainEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      );
      if (!mainEntry) {
        logger.warn(
          { sourceGroup },
          'classroom_refresh requested but no main group registered',
        );
        break;
      }
      const [mainJid, mainGroup] = mainEntry;

      const refreshFile = path.join(
        GROUPS_DIR,
        'global',
        'classroom',
        'last_refresh.json',
      );
      try {
        const last = JSON.parse(fs.readFileSync(refreshFile, 'utf-8'));
        if (last.ok && last.at) {
          const ageMs = Date.now() - new Date(last.at).getTime();
          if (ageMs >= 0 && ageMs < 15 * 60 * 1000) {
            logger.info(
              { sourceGroup, ageMs },
              'classroom_refresh skipped — recent successful refresh',
            );
            break;
          }
        }
      } catch {
        // No prior refresh file or unreadable — proceed.
      }

      const now = new Date().toISOString();
      const taskId = `cr-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      createTask({
        id: taskId,
        group_folder: mainGroup.folder,
        chat_jid: mainJid,
        prompt:
          `Google Classroom refresh requested by ${data.requestedBy || sourceGroup}.\n\n` +
          `Step 1 — run \`bash /workspace/global/classroom/fetch.sh\`. ` +
          `That script handles SAML auth and session refresh deterministically; on exit 0 Classroom is loaded in agent-browser and snapshots are at /tmp/cr_dashboard.{html,snap,interactive,png}. If it exits non-zero, report the failure and stop.\n\n` +
          `Step 2 — extract assignments and course state into /workspace/global/classroom/data.json. ` +
          `Course URLs are listed in /workspace/global/classroom/credentials.json under the "courses" key — iterate them via agent-browser and pull pending/upcoming assignments. ` +
          `Use the existing /workspace/extra/.../classroom_last_check.json shape if present (assignments keyed by id, with title/course/published/due/teacher/status). Set fetchedAt to the current UTC ISO timestamp.\n\n` +
          `Do not message the chat unless something fails. fetch.sh already updates last_refresh.json; do not overwrite it on success.`,
        script: null,
        schedule_type: 'once',
        schedule_value: now,
        context_mode: 'isolated',
        next_run: now,
        status: 'active',
        created_at: now,
      });
      logger.info(
        { taskId, sourceGroup, requestedBy: data.requestedBy },
        'Classroom refresh task scheduled for main',
      );
      deps.onTasksChanged();
      break;
    }

    case 'smartschool_refresh': {
      // Any registered group can request a refresh; the main agent does the work.
      const mainEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      );
      if (!mainEntry) {
        logger.warn(
          { sourceGroup },
          'smartschool_refresh requested but no main group registered',
        );
        break;
      }
      const [mainJid, mainGroup] = mainEntry;

      // Throttle: skip if a successful refresh happened within the last 15 min.
      const refreshFile = path.join(
        GROUPS_DIR,
        'global',
        'smartschool',
        'last_refresh.json',
      );
      try {
        const last = JSON.parse(fs.readFileSync(refreshFile, 'utf-8'));
        if (last.ok && last.at) {
          const ageMs = Date.now() - new Date(last.at).getTime();
          if (ageMs >= 0 && ageMs < 15 * 60 * 1000) {
            logger.info(
              { sourceGroup, ageMs },
              'smartschool_refresh skipped — recent successful refresh',
            );
            break;
          }
        }
      } catch {
        // No prior refresh file or unreadable — proceed.
      }

      const now = new Date().toISOString();
      const taskId = `ss-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      createTask({
        id: taskId,
        group_folder: mainGroup.folder,
        chat_jid: mainJid,
        prompt:
          `SmartSchool refresh requested by ${data.requestedBy || sourceGroup}.\n\n` +
          `Step 1 — run \`bash /workspace/global/smartschool/fetch.sh\`. ` +
          `That script handles session validation and re-login deterministically; on exit 0 the dashboard is loaded in agent-browser and snapshots are at /tmp/ss_dashboard.{html,snap,interactive,png}. If it exits non-zero, report the failure and stop.\n\n` +
          `Step 2 — extract the dashboard data into the schema of the existing /workspace/global/smartschool/data.json. ` +
          `Required top-level keys: fetchedAt, student, school, counters{unreadMessages,unreadNotifications}, grades[], msgs[], upcoming_tests[], timetable{<day>: [{period,subject,teacher,room?}]}. ` +
          `Use agent-browser eval / the saved snapshots to read the rendered DOM. Set fetchedAt to the current UTC ISO timestamp. Write the result back to /workspace/global/smartschool/data.json.\n\n` +
          `Do not message the chat unless something fails. fetch.sh already updates last_refresh.json; do not overwrite it on success.`,
        script: null,
        schedule_type: 'once',
        schedule_value: now,
        context_mode: 'isolated',
        next_run: now,
        status: 'active',
        created_at: now,
      });
      logger.info(
        { taskId, sourceGroup, requestedBy: data.requestedBy },
        'SmartSchool refresh task scheduled for main',
      );
      deps.onTasksChanged();
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
