package voiceui

import "embed"

// Files contains the local microphone experiment. No gateway secret is embedded.
//
//go:embed index.html app.js styles.css pcm-capture-worklet.js
var Files embed.FS
