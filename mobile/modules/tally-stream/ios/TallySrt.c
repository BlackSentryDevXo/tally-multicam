//
//  TallySrt.c
//

#include "TallySrt.h"
#include "srt.h"
#include <netdb.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/syslog.h>

static pthread_once_t g_once = PTHREAD_ONCE_INIT;
static int g_startup = -1;

static void tally_srt_init(void) {
  g_startup = srt_startup();
  srt_setloglevel(LOG_ERR);
}

static void set_err(char* err, int errLen, const char* what, const char* detail) {
  if (err == NULL || errLen <= 0) return;
  snprintf(err, (size_t)errLen, "%s%s%s", what, detail ? ": " : "", detail ? detail : "");
}

int tally_srt_connect(const char* host, int port, const char* streamid, int latencyMs, char* err, int errLen) {
  pthread_once(&g_once, tally_srt_init);
  if (g_startup < 0) {
    set_err(err, errLen, "srt_startup failed", srt_getlasterror_str());
    return -1;
  }

  char portStr[8];
  snprintf(portStr, sizeof(portStr), "%d", port);
  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_DGRAM;
  struct addrinfo* res = NULL;
  if (getaddrinfo(host, portStr, &hints, &res) != 0 || res == NULL) {
    set_err(err, errLen, "Cannot resolve hub address", host);
    return -1;
  }

  SRTSOCKET s = srt_create_socket();
  if (s == SRT_INVALID_SOCK) {
    freeaddrinfo(res);
    set_err(err, errLen, "srt_create_socket failed", srt_getlasterror_str());
    return -1;
  }

  SRT_TRANSTYPE tt = SRTT_LIVE;
  int yes = 1;
  int payload = SRT_LIVE_DEF_PLSIZE; // 1316 = 7 * 188 (MPEG-TS)
  int connTimeoutMs = 3000;
  int sndTimeoutMs = 500; // never block the encoder thread for long on a stalled link
  srt_setsockflag(s, SRTO_TRANSTYPE, &tt, sizeof(tt));
  srt_setsockflag(s, SRTO_SENDER, &yes, sizeof(yes));
  srt_setsockflag(s, SRTO_LATENCY, &latencyMs, sizeof(latencyMs));
  srt_setsockflag(s, SRTO_PAYLOADSIZE, &payload, sizeof(payload));
  srt_setsockflag(s, SRTO_CONNTIMEO, &connTimeoutMs, sizeof(connTimeoutMs));
  srt_setsockflag(s, SRTO_SNDTIMEO, &sndTimeoutMs, sizeof(sndTimeoutMs));
  if (streamid != NULL && streamid[0] != '\0') {
    srt_setsockflag(s, SRTO_STREAMID, streamid, (int)strlen(streamid));
  }

  int rc = srt_connect(s, res->ai_addr, (int)res->ai_addrlen);
  freeaddrinfo(res);
  if (rc == SRT_ERROR) {
    set_err(err, errLen, "SRT connect failed", srt_getlasterror_str());
    srt_close(s);
    return -1;
  }
  return (int)s;
}

int tally_srt_send(int sock, const uint8_t* data, int len) {
  if (sock < 0) return -1;
  int rc = srt_sendmsg2((SRTSOCKET)sock, (const char*)data, len, NULL);
  return rc == SRT_ERROR ? -1 : rc;
}

void tally_srt_close(int sock) {
  if (sock >= 0) srt_close((SRTSOCKET)sock);
}

double tally_srt_rtt_ms(int sock) {
  if (sock < 0) return -1;
  SRT_TRACEBSTATS st;
  if (srt_bstats((SRTSOCKET)sock, &st, 0) != 0) return -1;
  return st.msRTT;
}

int tally_srt_take_dropped(int sock) {
  if (sock < 0) return 0;
  SRT_TRACEBSTATS st;
  if (srt_bstats((SRTSOCKET)sock, &st, 1) != 0) return 0;
  return st.pktSndDrop;
}

const char* tally_srt_last_error(void) {
  return srt_getlasterror_str();
}
