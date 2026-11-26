
// Appended to the stock Jitsi config.js by create.sh — the lobby OFF is the whole point.
//
// The public meet.jit.si keeps the lobby on, so a guest (our bot) lands in "Asking to join
// meeting… no moderators have yet arrived" and the conference never starts unless a human
// signs in. With the lobby off, the first participant to arrive is the moderator and the
// conference starts by itself — which is what makes an unattended test possible.
config.lobby.enabled = false;

// No display name required: the bot already carries one, and the pre-join screen is one
// more click the join brick has to get right.
config.requireDisplayName = false;
