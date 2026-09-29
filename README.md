If you are reading this on github it probably means this is still my personal version, and if you install it from here I am making no claims to support this for 3rd parties although you are welcome to try, however if you do try from here I request that you try to make your BBS visually distinct - if I'm sharing functonality I don't want it to come at the cost of my own aesthetic being co-opted as something that is perceived as "stock".  You're certainly welcome to pick at the carcass of this code and create your own thing that takes what you like from here though, that's how this came to be from webv4.

## Why hard fork webv4

This is my hard fork of webv4, the primary reason is that is a hard fork is because it is now a Single Page App.  To me, I had good reason to make this change, I think if you are going to embed a web-terminal in the web-app you shouldn't have to relogon every time you change pages.  It's not modernization for modernization's sake.

## What else is in this fork that's not in the original?

This version is a lot more graphical than earlier versions:
 - it has the capability to use ANSI graphics (saved as .bin files) as web icons
 - it can show and parse ANSI graphics in the forums
 - The web terminal is responsive to its container and fills width.  Will adjust terminal rows and columns with size changes in addition to font sizing. (traditional sysops might hate this if their BBS is geared toward a fixed resolution, which is the status quo, but not on my bbs, so this feature is awesome for me, sorry, not sorry
 - CRT effects and animations on the terminal that are tasteful and not overdone
 - it has a synchronet oneliner interface that suports avatars, colorized text input and output
 - it supports avatarChat, interBBS chat with avatars live (also available for webv4)

 Also:
 - web and terminal integration may also be novel, essentially if the user is logged on via the web and opens the terminal, they will be rlogin'd in with no password prompt for the terminal.
 - There should no longer be a jquery dependency for the vanilla js purists 

# If this interests you...
Not trying to hoard these changes but also do not want to submit a hard fork to sbbs repo such that I wind up being the support system or only maintainer of something that's not my baby and is part of some major plumbing.  But I do think a lot of the thing here could be good to have supported out of the box for what it's worth so I guess if anyone has some will to see this be unsiloed, play around with it, run some tests, write some code, surgically update the sbbs web code, i'm not sure what next steps would be, but i share this tech stack that's working for me, for whatever it's worth.  

## Profiles, Friends and media embeds

- `?page=013-profile.xjs&user=<alias>` (short link `/u/?<alias>`): a member's
  profile page in the spirit of the classic two-column social profile
  (avatar, mood, latest update, details, contact box, profile song,
  creations, About Me from their wiki page, friends, wall). Members only
  (`webctrl.ini`). Owners edit headline / mood / song / featured friends /
  wall policy / theme + colours inline. Data: `root/api/social.ssjs` over
  the shared store `mods/load/social_lib.js` (the terminal shell uses the
  same one, so friendships and posts are common). Unset themes default to
  the CGA preset.
- Music credit: a track is the member's when the MP3's composer tag (or the
  records override) names them, then the featured artist ("feat. X"), the
  uploader, the filename suffix. Being only the lead artist (the house bot
  fronts most tracks) lists it as a collaboration with a "with <owner>" tag,
  counted separately in the Music heading; `?call=creations` rows carry
  `role`, `collab`, `collabWith`.
- Forum Activity box on the profile: `?call=forum&user=..&page=N` lists their
  posts across every sub the viewer may read (alias + sysop-linked network
  handles, so posts from other boards under their handle are included),
  10 per page with the sub's forum icon, date, network/sub, recipient and a
  snippet; Expand fetches `?call=forum-post` (the forum's own HTML renderer);
  "Open thread" deep-links into `002-forum.xjs` using the same thread keying
  as the forum page and highlights the message once the thread renders.
- Wiki pages accept media embeds: `![ansi](file.ans)`, `![track](song.mp3)`,
  `![image](pic.png)`, `![avatar](Alias)` (`![kind:label](..)` for a caption,
  `dir_code:file` for other creation areas). `lib/wiki-embeds.js` renders them
  server-side and only ever resolves targets inside the creation directories.
  The wiki editor gets an "Insert my art / track" picker and "Draw ANSI"
  (ANSI editor -> your ANSI area -> embed).
