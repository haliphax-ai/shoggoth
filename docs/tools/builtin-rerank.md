Score and order candidate documents against a query with a rerank model — returns `{index, relevance_score}` pairs ordered by relevance. Backed by the Cohere-style rerank API (`POST /v1/rerank`), compatible with Cohere and OpenRouter's endpoint (see <https://openrouter.ai/docs/api/overview/reranking>).

**Feature gating:** the feature only exists when the `rerank` config section has at least one provider with at least one model. When it does not, the `builtin-rerank` tool is not injected, the `rerank_documents` control op responds as an unknown op, and the `shoggoth rerank` CLI command (including its help and its entry in `shoggoth --help`) is inert/hidden.

## Parameters

| Param        | Type   | Required | Notes                                                                                                                 |
| ------------ | ------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `model`      | string | no¹      | Model in `provider-id/model-name` format (e.g. `openrouter-cohere/cohere/rerank-v3.5`). Omit to use the default model |
| `query`      | string | yes      | The query text used to score document relevance                                                                       |
| `documents`  | array  | yes      | Candidate documents to score, as an array of strings. Results reference documents by position (`index`)               |
| `top_n`      | number | no       | Return at most this many results (honored server-side). Omitting returns all documents scored                         |
| `timeout_ms` | number | no       | Request timeout in milliseconds                                                                                       |

¹ Falls back to the `rerank.defaultModel` configured model. When no default is configured, `model` is required.

## Result

Results come back ordered by descending `relevance_score`; each `index` maps to the position in the input `documents` array:

```json
{
  "status": "complete",
  "model": "cohere/rerank-v3.5",
  "results": [
    { "index": 1, "relevance_score": 0.987, "document": "echoed document text" },
    { "index": 0, "relevance_score": 0.12 }
  ]
}
```

## Configuration

```json
{
  "rerank": {
    "defaultModel": "openrouter-cohere/cohere/rerank-v3.5",
    "providers": {
      "openrouter-cohere": {
        "kind": "cohere",
        "baseUrl": "https://openrouter.ai/api",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "models": { "cohere/rerank-v3.5": {} }
      }
    }
  }
}
```

- `kind` is `cohere` for the Cohere-style wire protocol; `baseUrl` is the API root (`/v1/rerank` is appended).
- `apiKey` or `apiKeyEnv` supplies the bearer token.
- `defaultModel` must be a configured model in `provider-id/model-name` format.
- `memorySearch.enabled` (default `true`) controls automatic reranking of `memory-search` results; it requires `defaultModel` and gates only the memory-search integration. Set it to `false` to opt out.

## RAG integration

`memory-search` reranks its retrieved hits automatically — there are no per-call rerank parameters. As soon as `rerank.defaultModel` is configured, each search re-scores and re-orders its candidates with the rerank model; set `rerank.memorySearch.enabled` to `false` to opt out and keep plain retrieval order. The response indicates when reranking ran: it flags `"reranked": true`, names the model in `rerankModel`, and each reordered hit carries a `rerankScore`. When no default model is configured, or the flag is off, searches return the normal retrieval order. Failures degrade gracefully to the original retrieval order with a `rerankNote` explaining why. The flag gates only this memory-search integration — the `builtin-rerank` tool and `rerank_documents` op remain available whenever a provider with models is configured. Workflow tool tasks can call `builtin-rerank` directly the same way the agent tool does.

## CLI

```
shoggoth rerank rank [--model <provider/model>] --query <text> --documents <json> [--top <n>] [--timeout <ms>]
shoggoth rerank models   List configured rerank models
```
