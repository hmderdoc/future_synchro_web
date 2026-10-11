/* chat-limits.js - message length limits shared by the chat API and page.
 *
 * api/chat.ssjs truncates to these before writing to the chat server, and
 * pages/001-chat.xjs sets the composer's maxlength from the same value, so the
 * box never accepts text the server would cut off.
 */
var CHAT_MAX_MESSAGE_LEN = 1000;     /* plain text, public and private */
var CHAT_MAX_BITMAP_LEN = 32000;     /* a [BITMAP|...] art payload */
