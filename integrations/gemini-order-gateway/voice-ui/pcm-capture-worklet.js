class PcmCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.recording = false;
        this.offset = 0;
        this.buffer = new Float32Array(1024);
        this.port.onmessage = event => {
            this.recording = event.data?.recording === true;
            this.offset = 0;
        };
    }

    process(inputs) {
        const channel = inputs[0]?.[0];
        if (!this.recording || !channel?.length) return true;
        let sourceOffset = 0;
        while (sourceOffset < channel.length) {
            const count = Math.min(channel.length - sourceOffset, this.buffer.length - this.offset);
            this.buffer.set(channel.subarray(sourceOffset, sourceOffset + count), this.offset);
            this.offset += count;
            sourceOffset += count;
            if (this.offset === this.buffer.length) {
                const completed = this.buffer;
                this.port.postMessage(completed, [completed.buffer]);
                this.buffer = new Float32Array(1024);
                this.offset = 0;
            }
        }
        return true;
    }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
