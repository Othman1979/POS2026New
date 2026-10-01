// True while this client is ending its own session (logout, idle logout, shift close), so
// the socket does not reconnect into the server's disconnect of that session.
let sessionEnding = false;
export const isSessionEnding = () => sessionEnding;
export const setSessionEnding = (value = true) => { sessionEnding = value; };
