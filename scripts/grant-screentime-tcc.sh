#!/bin/bash
# Grant Automation (AppleEvents) permission to the processes nanoclaw uses
# to run the family screentime script.
#
# Adds /bin/bash → System Events + System Settings to the user TCC database.
# Node is already allowed; bash (the direct osascript parent) is not.
#
# Run once as yourself (no sudo needed — modifies ~/Library TCC db).

set -e

TCC_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"

add_entry() {
  local client="$1"
  local target="$2"
  echo "  Granting: $client → $target"
  sqlite3 "$TCC_DB" "
    INSERT OR REPLACE INTO access (
      service,
      client, client_type,
      auth_value, auth_reason, auth_version,
      csreq, policy_id,
      indirect_object_identifier_type,
      indirect_object_identifier,
      indirect_object_code_identity,
      flags,
      last_modified, last_reminded,
      pid, pid_version, boot_uuid
    ) VALUES (
      'kTCCServiceAppleEvents',
      '$client', 1,
      2, 3, 1,
      NULL, NULL,
      0,
      '$target',
      NULL,
      0,
      CAST(strftime('%s','now') AS INTEGER),
      CAST(strftime('%s','now') AS INTEGER),
      NULL, NULL, 'UNUSED'
    );
  "
}

echo "Adding Automation permissions to TCC database..."

add_entry "/bin/bash" "com.apple.systemevents"
add_entry "/bin/bash" "com.apple.systempreferences"

echo ""
echo "Done. Verify in System Settings → Privacy & Security → Automation"
echo "You should see 'bash' listed under System Events and System Settings."
echo ""
echo "Current AppleEvents entries for bash:"
sqlite3 "$TCC_DB" "SELECT client, auth_value, indirect_object_identifier FROM access WHERE service='kTCCServiceAppleEvents' AND client LIKE '%bash%';"
