#!/bin/bash
# Test what GUI operations work from the launchd context
LOG="/tmp/gui-access-test.log"
echo "=== $(date) ===" > "$LOG"

echo "1. osascript return test:" >> "$LOG"
osascript -e 'return "hello"' >> "$LOG" 2>&1

echo "2. osascript activate System Settings:" >> "$LOG"
osascript -e 'tell application "System Settings" to activate' >> "$LOG" 2>&1

echo "3. open URL:" >> "$LOG"
open "x-apple.systempreferences:com.apple.Screen-Time-Settings.extension" >> "$LOG" 2>&1

echo "4. sleep 3, check windows:" >> "$LOG"
sleep 3
osascript -e 'tell application "System Events" to tell process "System Settings" to return (count windows)' >> "$LOG" 2>&1

echo "5. window name:" >> "$LOG"
osascript -e 'tell application "System Events" to tell process "System Settings" to return name of window 1' >> "$LOG" 2>&1

echo "DONE" >> "$LOG"
