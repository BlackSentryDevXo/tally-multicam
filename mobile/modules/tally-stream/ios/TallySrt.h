//
//  TallySrt.h
//  Minimal C facade over libsrt (caller mode, live transtype), callable from Swift.
//  Kept free of libsrt headers so it can be a public header of the pod.
//

#ifndef TallySrt_h
#define TallySrt_h

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Connects to `host:port` in caller mode. Returns a socket handle >= 0, or -1 (and fills `err`).
int tally_srt_connect(const char* host, int port, const char* streamid, int latencyMs, char* err, int errLen);
/// Sends one SRT message (<= 1316 bytes = 7 TS packets). Returns bytes sent, or -1 on a broken connection.
int tally_srt_send(int sock, const uint8_t* data, int len);
/// Closes the socket (safe to call with -1).
void tally_srt_close(int sock);
/// Round-trip time in ms, or -1 if unknown.
double tally_srt_rtt_ms(int sock);
/// Packets the sender dropped as too late since the last call (clears the counter).
int tally_srt_take_dropped(int sock);
/// Last libsrt error string (thread-local inside libsrt).
const char* tally_srt_last_error(void);

#ifdef __cplusplus
}
#endif

#endif /* TallySrt_h */
