---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps, fill forms, take screenshots, extract data, and test web pages. Use whenever a browser would be useful, not just when the user explicitly asks.
allowed-tools: Bash(agent-browser:*), Bash(/Applications/Google*Chrome*:*)
---

# Browser Automation with agent-browser

## Connection

Prefer connecting to the user's Chrome (has login sessions) via CDP:

```bash
agent-browser --cdp 9222 open <url>
```

If Chrome is not running, launch it first:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/Users/yuelunyu/chrome &
sleep 3
agent-browser --cdp 9222 open <url>
```

Fallback to standalone browser (no login state):

```bash
agent-browser open <url>
```

## Core workflow

1. Navigate: `agent-browser --cdp 9222 open <url>`
2. Snapshot: `agent-browser --cdp 9222 snapshot -i` (interactive elements with refs)
3. Interact using refs from the snapshot
4. Re-snapshot after navigation or significant DOM changes

## Commands

### Navigation

```bash
agent-browser --cdp 9222 open <url>      # Navigate to URL
agent-browser --cdp 9222 back            # Go back
agent-browser --cdp 9222 forward         # Go forward
agent-browser --cdp 9222 reload          # Reload page
```

### Snapshot

```bash
agent-browser --cdp 9222 snapshot -i         # Interactive elements only (recommended)
agent-browser --cdp 9222 snapshot -c         # Compact output
agent-browser --cdp 9222 snapshot -d 3       # Limit depth to 3
agent-browser --cdp 9222 snapshot -s "#main" # Scope to CSS selector
```

### Interactions (use @refs from snapshot)

```bash
agent-browser --cdp 9222 click @e1           # Click
agent-browser --cdp 9222 fill @e2 "text"     # Clear and type
agent-browser --cdp 9222 type @e2 "text"     # Type without clearing
agent-browser --cdp 9222 press Enter         # Press key
agent-browser --cdp 9222 select @e1 "value"  # Select dropdown option
agent-browser --cdp 9222 scroll down 500     # Scroll page
agent-browser --cdp 9222 upload @e1 file.pdf # Upload files
```

### Get information

```bash
agent-browser --cdp 9222 get text @e1        # Get element text
agent-browser --cdp 9222 get value @e1       # Get input value
agent-browser --cdp 9222 get attr @e1 href   # Get attribute
agent-browser --cdp 9222 get title           # Get page title
agent-browser --cdp 9222 get url             # Get current URL
```

### Screenshots & PDF

```bash
agent-browser --cdp 9222 screenshot          # Save to temp directory
agent-browser --cdp 9222 screenshot path.png # Save to specific path
agent-browser --cdp 9222 screenshot --full   # Full page
agent-browser --cdp 9222 pdf output.pdf      # Save as PDF
```

### Wait

```bash
agent-browser --cdp 9222 wait @e1                     # Wait for element
agent-browser --cdp 9222 wait 2000                     # Wait milliseconds
agent-browser --cdp 9222 wait --text "Success"         # Wait for text
agent-browser --cdp 9222 wait --load networkidle       # Wait for network idle
```

### Semantic locators (alternative to refs)

```bash
agent-browser --cdp 9222 find role button click --name "Submit"
agent-browser --cdp 9222 find text "Sign In" click
agent-browser --cdp 9222 find label "Email" fill "user@test.com"
```

### JavaScript

```bash
agent-browser --cdp 9222 eval "document.title"
```

### Tabs

```bash
agent-browser --cdp 9222 tab list            # List open tabs
agent-browser --cdp 9222 tab new             # New tab
agent-browser --cdp 9222 tab 2               # Switch to tab
agent-browser --cdp 9222 tab close           # Close current tab
```
