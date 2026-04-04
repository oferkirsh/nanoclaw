#!/bin/bash
# family-screentime.sh — Get Screen Time data for a family member via System Settings UI automation
# Usage: ./family-screentime.sh [member_name]
# Requires: osascript with Accessibility/Automation permissions
# Returns: JSON with app usage data

MEMBER="${1:-noam kirshenbaum}"

# Debug log (remove after debugging)
DEBUG_LOG="/tmp/family-screentime-debug.log"
echo "=== $(date) ===" >> "$DEBUG_LOG"
echo "MEMBER: $MEMBER" >> "$DEBUG_LOG"

# Do everything in a single osascript to avoid launchd GUI session issues.
# The `open` command doesn't work from launchd, but AppleScript `activate` does.
DATA=$(osascript << APPLESCRIPT 2>>"$DEBUG_LOG"
-- Quit System Settings to reset sub-page state
tell application "System Settings" to quit
delay 2

-- Launch System Settings
do shell script "open 'x-apple.systempreferences:com.apple.Screen-Time-Settings.extension'"
delay 3
tell application "System Settings" to activate
delay 1

tell application "System Events"
    tell process "System Settings"
        -- Wait for window
        repeat 15 times
            if (count windows) > 0 then exit repeat
            delay 0.5
        end repeat

        if (count windows) = 0 then
            return ""
        end if

        -- If we landed on a sub-page, navigate back
        repeat 3 times
            if name of window 1 contains "–" then
                keystroke "[" using command down
                delay 1.5
            else
                exit repeat
            end if
        end repeat

        -- Select the family member from the popup
        try
            set scrollArea to scroll area 1 of group 1 of group 2 of splitter group 1 of group 1 of window 1
            set theBtn to pop up button 1 of group 1 of scrollArea
            if value of theBtn is not "$MEMBER" then
                click theBtn
                delay 1
                click menu item "$MEMBER" of menu 1 of theBtn
                delay 2
            end if
            -- Click App & Website Activity
            click button 1 of group 2 of scrollArea
            delay 4
        on error e
            return ""
        end try

        -- Wait for window to be ready after navigation
        repeat 10 times
            if (count windows) > 0 then exit repeat
            delay 0.5
        end repeat

        -- Extract all static text from the activity view
        set r to ""
        set allEls to entire contents of window 1
        repeat with e in allEls
            try
                if class of e is static text then
                    set v to value of e
                    if v is not missing value and v is not "" then
                        set r to r & v & linefeed
                    end if
                end if
            end try
        end repeat
        return r
    end tell
end tell
APPLESCRIPT
)

echo "RAW DATA:" >> "$DEBUG_LOG"
echo "$DATA" >> "$DEBUG_LOG"
echo "---" >> "$DEBUG_LOG"

# Parse the raw text into structured JSON
python3 << PYTHON
import json, re, sys

raw = """$DATA"""
lines = [l.strip() for l in raw.strip().split('\n') if l.strip()]

result = {"member": "$MEMBER", "apps": [], "categories": []}

in_apps = False
in_categories = False
skip_sidebar = True

for i, line in enumerate(lines):
    if line in ("Device", "Usage"):
        skip_sidebar = False
        continue
    if skip_sidebar:
        continue

    # Match abbreviated ("1h 59m") or full-word ("1 hour 59 minutes") time patterns
    time_pat = r'^(\d+\s*(?:hours?|h))?\s*(\d+\s*(?:minutes?|m))?\s*(\d+\s*(?:seconds?|s))?$'
    time_match = re.match(time_pat, line, re.IGNORECASE)

    if line == "All Apps" or line == "All Usage":
        in_apps = True
        in_categories = False
        continue

    if not in_apps and i + 1 < len(lines):
        next_line = lines[i + 1] if i + 1 < len(lines) else ""
        if re.match(time_pat, next_line, re.IGNORECASE) and not time_match:
            if not any(c["name"] == line for c in result["categories"]):
                result["categories"].append({"name": line, "time": next_line})
            continue

    if in_apps and not time_match:
        if i + 1 < len(lines):
            next_line = lines[i + 1]
            if re.match(time_pat, next_line, re.IGNORECASE):
                result["apps"].append({"name": line, "time": next_line})

    if time_match and "total" not in result:
        result["total"] = line

print(json.dumps(result, indent=2))
PYTHON

# Minimize System Settings
osascript -e 'tell application "System Settings" to set miniaturized of window 1 to true' 2>/dev/null
