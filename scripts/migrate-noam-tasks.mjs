import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

const DB = '/Users/ofer/Projects/nanoclaw/store/messages.db';
const TZ = 'Asia/Jerusalem';
const NOAM_JID = '120363409105788630@g.us';
const MAIN_JID = '120363425575053270@g.us';

const nextCron = (expr) =>
  CronExpressionParser.parse(expr, { tz: TZ }).next().toISOString();

const PROMPT_REFRESH = `אתה Claw. משימה שקטה — אל תשלח שום הודעה לנועם.

מטרה: לרענן SmartSchool ו-Google Classroom לפני הבריפינג של 07:15.

## שלב 1: SmartSchool
\`\`\`bash
bash /workspace/global/smartschool/fetch.sh
\`\`\`
אם נכשל, הרץ:
\`\`\`bash
bash /workspace/global/smartschool/relogin.sh && bash /workspace/global/smartschool/fetch.sh
\`\`\`
בדוק \`/workspace/global/smartschool/last_refresh.json\` שהתעדכן עם \`ok=true\`.

## שלב 2: Google Classroom
\`\`\`bash
agent-browser state load /workspace/global/classroom/session.json
agent-browser open "https://classroom.google.com/u/0/a/not-turned-in/all"
sleep 3
agent-browser get url
\`\`\`
אם ה-URL מכיל \`accounts.google.com\` או \`login\` — סשן פג. כתוב ל-\`/workspace/global/classroom/last_refresh.json\`:
\`\`\`json
{"ok": false, "reason": "session_expired", "at": "<ISO now>"}
\`\`\`
אחרת — \`agent-browser snapshot -i\` וחלץ לכל משימה: \`title\`, \`course\`, \`due\` (YYYY-MM-DD), \`teacher\`. בנה key יציב \`{course}_{title-slug}\`. כתוב ל-\`/workspace/global/classroom/data.json\` בפורמט:
\`\`\`json
{"assignments": {"<key>": {...}}, "fetchedAt": "<ISO now>"}
\`\`\`
ועדכן \`last_refresh.json\` עם \`{"ok": true, "at": "<ISO now>"}\`.

## שלב 3: דיווח
- אם הכל הצליח — אל תשלח שום הודעה (לא לנועם, לא ל-main).
- אם משהו נכשל — שלח שורה אחת ל-main:
  \`\`\`
  mcp__nanoclaw__send_message(target_jid="${MAIN_JID}", text="Claw: רענון בוקר נכשל — [smartschool/classroom]: <סיבה קצרה>")
  \`\`\`

עטוף הכל ב-<internal>.`;

const PROMPT_BRIEFING = `אתה Claw, עוזר אישי של נועם קירשנבוים (בת 12, כיתה ז, תיכון חדש ע"ש רבין).
שלח לה בריפינג בוקר אחד מאוחד. **אסור להמציא — רק מה שמופיע בקבצים.**

הנתונים כבר רוענו ב-06:30 (ל-\`/workspace/global/smartschool/data.json\` ו-\`/workspace/global/classroom/data.json\`). אל תרענן שוב כאן.

## שלב 1: כדורסל
\`cat /workspace/extra/main-data/noam-schedule.md\` → השורה של היום. אם אין — "אין אימון היום לפי הלוז".

## שלב 2: קרא נתונים טריים
- \`cat /workspace/global/smartschool/data.json\`
- \`cat /workspace/global/smartschool/last_refresh.json\` — אם \`ok=false\` או stale (>3 שעות מ-\`at\`), בסעיפי SmartSchool כתוב "לא זמין כרגע".
- \`cat /workspace/global/classroom/data.json\` + \`/workspace/global/classroom/last_refresh.json\` (אותו טיפול).

## שלב 3: חישוב "חדש מאתמול"
טען:
- \`/workspace/group/smartschool_last_check.json\` (אם לא קיים — אין רף השוואה, אל תכריז על שום דבר כ"חדש").
- \`/workspace/group/classroom_last_check.json\` (אותו דבר).

חשב:
- **SmartSchool חדש**: גידול ב-\`unreadMessages\`/\`unreadNotifications\` או הודעה/התראה חדשה שלא הופיעה ב-last_check.
- **Classroom חדש**: keys ב-\`data.json.assignments\` שאינם ב-last_check (משימות חדשות), או \`due\` שונה (תאריכים שזזו).

## שלב 4: שלח לנועם (עברית, נקבה, פורמט WhatsApp עם \`*bold*\` ו-\`•\`)
\`\`\`
☀️ בוקר טוב נועם! [יום + תאריך]

💊 קודם כל — לקחת כדורים!

🏀 כדורסל היום: [לוז / אין אימון]

🆕 *חדש מאתמול:*
• [SmartSchool: כותרת קצרה של הודעה/התראה חדשה]
• [Classroom: שם משימה (קורס) — עד YYYY-MM-DD]
[אם אין כלום — דלג על הסעיף הזה לגמרי, אל תכתוב "אין חדש"]

📚 *שיעורי בית להיום (SmartSchool):* [רשימה / אין]

📋 *משימות Classroom פתוחות לשבוע הקרוב:* [רשימה / אין]

📢 *עדכוני בית ספר היום:* [ChangesAndMessagesDataForToday / אין]
\`\`\`

**אל תכתוב "שאלי את אבא".** מידע חסר → "לא זמין כרגע".

## שלב 5: עדכן last_check
שמור ב-\`/workspace/group/smartschool_last_check.json\`:
\`\`\`json
{"unreadMessages": <N>, "unreadNotifications": <N>, "messageIds": [...], "notificationIds": [...], "checkedAt": "<ISO>"}
\`\`\`
שמור ב-\`/workspace/group/classroom_last_check.json\`:
\`\`\`json
{"assignments": {<כל ה-keys מ-data.json>}, "checkedAt": "<ISO>"}
\`\`\`

## שלב אחרון: סיכום ל-Ofer ב-main (תמיד)
\`\`\`
mcp__nanoclaw__send_message(target_jid="${MAIN_JID}", text="Claw: שלחתי בריפינג בוקר לנועם.\\nסיכום:\\n• חדש: <X SmartSchool, Y Classroom>\\n• <סטטוס/שגיאה אם היתה>")
\`\`\`

**אסור לשלוח את הסיכום הזה לנועם.** עטוף שאר הרציונל ב-<internal>.`;

const PROMPT_AFTERNOON = `אתה Claw, עוזר של נועם קירשנבוים. אחרי יום הלימודים — בדוק SmartSchool **ו-**Google Classroom, ודווח לנועם רק אם יש משהו חדש מאז הבדיקה האחרונה.

## שלב 1: רענן SmartSchool
\`\`\`bash
bash /workspace/global/smartschool/fetch.sh
\`\`\`
אם נכשל: \`bash /workspace/global/smartschool/relogin.sh && bash /workspace/global/smartschool/fetch.sh\`.

## שלב 2: רענן Google Classroom
\`\`\`bash
agent-browser state load /workspace/global/classroom/session.json
agent-browser open "https://classroom.google.com/u/0/a/not-turned-in/all"
sleep 3
agent-browser get url
\`\`\`
אם הסשן פג (URL מכיל \`accounts.google.com\`/\`login\`) — דלג על Classroom, ציין כשגיאה ל-main בלבד.
אחרת — \`agent-browser snapshot -i\`, חלץ משימות (\`title\`, \`course\`, \`due\`, \`teacher\`), כתוב ל-\`/workspace/global/classroom/data.json\` ועדכן \`last_refresh.json\`.

## שלב 3: חישוב "חדש מאז הבריפינג של הבוקר"
טען \`/workspace/group/smartschool_last_check.json\` ו-\`/workspace/group/classroom_last_check.json\`.

- **SmartSchool**: גידול ב-counters או הודעות/התראות חדשות שלא ב-last_check. קרא פרטים עם \`Menu/GetPreviewUnreadMessages\` ו-\`Menu/GetPreviewUnreadNotifications\` אם יש חדש.
- **Classroom**: keys שב-\`data.json\` ולא ב-last_check (משימות חדשות), או \`due\` שונה (תאריכים שזזו).

## שלב 4: שלח לנועם — רק אם יש משהו חדש (אחד או יותר)
פורמט (WhatsApp, נקבה):
\`\`\`
📬 *עדכון אחה"צ — מה חדש מאז הבוקר*

✉️ *SmartSchool:*
• [כותרת הודעה/התראה]

📋 *Google Classroom:*
• *חדש:* [title] ([course]) — עד [due]
• *תאריך השתנה:* [title] — עכשיו עד [new_due] (היה [old_due])
\`\`\`
דלג על סעיף שאין בו כלום. **אם שני הסעיפים ריקים — אל תשלח כלום לנועם.**
אל תכתוב "שאלי את אבא".

## שלב 5: עדכן last_check
- \`/workspace/group/smartschool_last_check.json\` עם counters + IDs + checkedAt.
- \`/workspace/group/classroom_last_check.json\` עם המשימות הנוכחיות + checkedAt.

## שלב אחרון: סיכום ל-Ofer ב-main
שלח **רק אם** (א) שלחת הודעה לנועם, או (ב) הסשן פג / שגיאה. אם אין כלום — אל תשלח שום דבר ל-main.

\`\`\`
mcp__nanoclaw__send_message(target_jid="${MAIN_JID}", text="Claw: בדיקת אחה"צ — <מה דווח לנועם / שגיאה>\\nסיכום:\\n• <נקודה>")
\`\`\`

**אסור לשלוח את הסיכום לנועם.** עטוף רציונל פנימי ב-<internal>.`;

const db = new Database(DB);

// Show current state of affected rows
const before = db
  .prepare(
    `SELECT id, schedule_value, status, substr(prompt,1,50) AS preview
     FROM scheduled_tasks
     WHERE id IN ('task-1775369224683-iyd4xe','task-1775938970855-g7w8os','task-1775501960677-li3p4d')
     ORDER BY id`,
  )
  .all();
console.log('BEFORE:', JSON.stringify(before, null, 2));

const txn = db.transaction(() => {
  // A: insert new silent refresh
  const refreshId = `task-${Date.now()}-morning-refresh`;
  const refreshNext = nextCron('30 6 * * 0-4');
  db.prepare(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, context_mode, created_at)
     VALUES (?, ?, ?, ?, 'cron', '30 6 * * 0-4', ?, 'active', 'isolated', ?)`,
  ).run(
    refreshId,
    'whatsapp_claw-noam',
    NOAM_JID,
    PROMPT_REFRESH,
    refreshNext,
    new Date().toISOString(),
  );
  console.log(`A: inserted ${refreshId}, next_run=${refreshNext}`);

  // B: retime + reprompt briefing
  const briefingNext = nextCron('15 7 * * 0-4');
  db.prepare(
    `UPDATE scheduled_tasks
     SET schedule_value = '15 7 * * 0-4', prompt = ?, next_run = ?
     WHERE id = 'task-1775369224683-iyd4xe'`,
  ).run(PROMPT_BRIEFING, briefingNext);
  console.log(`B: briefing updated, next_run=${briefingNext}`);

  // C: combine 15:30 to SmartSchool + Classroom (cron unchanged)
  db.prepare(
    `UPDATE scheduled_tasks SET prompt = ? WHERE id = 'task-1775938970855-g7w8os'`,
  ).run(PROMPT_AFTERNOON);
  console.log(`C: 15:30 task updated to combined SmartSchool+Classroom`);

  // D: retire standalone 07:00/15:00 SmartSchool ping
  db.prepare(
    `UPDATE scheduled_tasks SET status = 'deleted' WHERE id = 'task-1775501960677-li3p4d'`,
  ).run();
  console.log(`D: standalone SmartSchool ping marked deleted`);
});

txn();

const after = db
  .prepare(
    `SELECT id, schedule_value, status, next_run, substr(prompt,1,50) AS preview
     FROM scheduled_tasks
     WHERE id IN ('task-1775369224683-iyd4xe','task-1775938970855-g7w8os','task-1775501960677-li3p4d')
        OR id LIKE '%-morning-refresh'
     ORDER BY schedule_value`,
  )
  .all();
console.log('AFTER:', JSON.stringify(after, null, 2));
db.close();
