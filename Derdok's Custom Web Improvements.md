# Derdok's Custom Web Improvements

## Architecture

- MAJOR REFACTOR: converted to single page app format so page refresh doesn't happen on every navigation.  This is the main reason I forked project.  This allows long lived services, for instance the chat service receives messages when not on chat page, and can notify the user.
- PERSISTENT TERMINAL FEATURE : Create a persistent fTelnet connection that survives navigating around the BBS web interface.  This is what I wanted in my website, so the other part of why I forked.
- PROGRESSIVE WEB APP - Allows your "BBS" to be installed with an icon like a desktop or mobile app using progressive web app technology
- TERMINAL AND WEB BIDIRECTIONAL CHANNEL: fTelnet <--> Web Communication: enables things such as playing sound, changing softkeyboard, making game pad controls appear, triggering synthesizer engines, launching radio, etc.

## Added features
- BUILT IN ANSI EDITOR: Ported moebius ANSI editor and embedded in places where ANSI can be sent, such as forums and chat.
- Auto-Terminal login: If you are logged in on web, it will rlogin you into the terminal, no password prompting required.
- FORUM ANSI MESSAGE RENDERING: Detect ANSI in forum messages and render them properly.  Enhance thread view.
- AVATAR AND ACCOUNT MANAGEMENT: Added avatar design component and selection on a web signup.  Also created a dedicated settings page.
- COOL CUSTOM ICONS: Use ANSI graphics (in .bin format) as icons for the web
- FILE AREA: Added File previews (mp3,bitmaps, ansi)
- AVATAR CHAT: Chat interbbs using JSON-CHAT and synchronet avatars.
- AVATAR MADNESS: Avatar based user lists, last callers, one liners and chat components.
- LOOK AT ART ON THE WEB: Web version of ANSI viewer.
- FTELNET monkey patching: make responsive and process packets faster.

## Other additions (probably won't work on your BBS)
- News reader
- Game launcher with detailed stats, filters and icons
- mp3 player - Futureland Record (mp3 player extension)

## Visual Polish
- Visual polish has been applied in various areas and some things have been structured a bit differently, but a lot of it is CSS and that should be individual to the BBS or bland by default.  Mine is spicy, however there may be some elements moved around here and there.
