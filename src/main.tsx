// First: inside Discord this reroutes network traffic through Discord's proxy, and Firebase
// captures the WebSocket constructor as soon as it loads.
import './discord/patch';

// The rest is loaded only after that. A static import isn't enough: Firebase is built into its
// own chunk, and the browser runs imported chunks before this file's code, so Firebase would
// keep the unpatched WebSocket and every database call would hang inside Discord.
void import('./start');
