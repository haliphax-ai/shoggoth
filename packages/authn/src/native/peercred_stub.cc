// Non-Linux: SO_PEERCRED unavailable — throw ERR_PEERCRED_NOT_IMPLEMENTED from native.

#include <node_api.h>

static napi_value ReadPeerCredStub(napi_env env, napi_callback_info info) {
  napi_throw_error(
      env,
      "ERR_PEERCRED_NOT_IMPLEMENTED",
      "SO_PEERCRED is only available on Linux; use operator_token auth or inject readPeerCred");
  return nullptr;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  if (napi_create_function(env, "readPeerCred", NAPI_AUTO_LENGTH, ReadPeerCredStub, nullptr, &fn) !=
      napi_ok) {
    return nullptr;
  }
  if (napi_set_named_property(env, exports, "readPeerCred", fn) != napi_ok) {
    return nullptr;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
