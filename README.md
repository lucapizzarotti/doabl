# doabl

Turn YouTube tutorials into an actionable checklist. Watch and do at the same time, without losing your flow.

doabl opens a panel next to the YouTube video where you turn what you watch into a list of **concrete actions**, each one anchored to the exact second of the video. Built for builders — devs and designers — who learn by doing.

## How it works

- **Add a step** with the action you need to take. doabl captures the timestamp automatically and pauses the video while you type.
- **Tap a step** and the video jumps to that second.
- **Check off** each step as you go. When you're done, mark the tutorial as completed.
- Everything is saved **per video**, locally in your browser.

## Install (development)

1. Clone or download this repo.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. **Load unpacked** → select the project folder.

## Privacy

doabl is **100% local and free**. It doesn't collect, store on servers, or transmit any personal data. Everything lives in your browser via `chrome.storage.local`.

→ [Privacy policy](https://lucapizzarotti.github.io/doabl/privacy-policy.html)

## Stack

Chrome extension (Manifest V3) · Vanilla JS · Side Panel API · `chrome.storage.local`
