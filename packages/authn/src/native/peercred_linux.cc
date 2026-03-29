// Linux SO_PEERCRED via getsockopt — N-API addon for @shoggoth/authn.

#define _GNU_SOURCE
#include <node_api.h>
#include <cstdio>
#include <errno.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static napi_value ReadPeerCred(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "readPeerCred(fd): expected socket fd (number)");
    return nullptr;
  }

  int32_t fd;
  if (napi_get_value_int32(env, args[0], &fd) != napi_ok) {
    napi_throw_type_error(env, nullptr, "readPeerCred(fd): fd must be an int32");
    return nullptr;
  }

  struct ucred cred;
  socklen_t len = sizeof(cred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
    char buf[256];
    snprintf(buf, sizeof(buf), "getsockopt(SO_PEERCRED): %s", strerror(errno));
    napi_throw_error(env, "ERR_PEERCRED_SYSCALL", buf);
    return nullptr;
  }

  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) return nullptr;

  napi_value pid_v, uid_v, gid_v;
  if (napi_create_int32(env, static_cast<int32_t>(cred.pid), &pid_v) != napi_ok) return nullptr;
  if (napi_create_uint32(env, static_cast<uint32_t>(cred.uid), &uid_v) != napi_ok) return nullptr;
  if (napi_create_uint32(env, static_cast<uint32_t>(cred.gid), &gid_v) != napi_ok) return nullptr;

  if (napi_set_named_property(env, obj, "pid", pid_v) != napi_ok) return nullptr;
  if (napi_set_named_property(env, obj, "uid", uid_v) != napi_ok) return nullptr;
  if (napi_set_named_property(env, obj, "gid", gid_v) != napi_ok) return nullptr;

  return obj;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  if (napi_create_function(env, "readPeerCred", NAPI_AUTO_LENGTH, ReadPeerCred, nullptr, &fn) !=
      napi_ok) {
    return nullptr;
  }
  if (napi_set_named_property(env, exports, "readPeerCred", fn) != napi_ok) {
    return nullptr;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
