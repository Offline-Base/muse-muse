# Models schemas {#models-schemas}

The full schema and model definitions referenced by the [Models](https://dev.meta.ai/docs/api-reference/models/list-models) endpoints. Each endpoint page links here for the detailed shape of its response objects.

## Schemas {#schemas}

### List Models Response {#list-models-response}

Response containing the list of available models.

| Field    | Type                                                                            | Required | Description                                 |
| -------- | ------------------------------------------------------------------------------- | -------- | ------------------------------------------- |
| `object` | `enum ('list')`                                                                 | Yes      | Object type; always `list`. (default: list) |
| `data`   | array of [`Model`](https://dev.meta.ai/docs/api-reference/models/schemas#model) | Yes      | List of model objects.                      |

### Model {#model}

Describes a model available for use with the API.

| Field      | Type             | Required | Description                                                                                                                   |
| ---------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`       | `string`         | Yes      | Identifier for the model.                                                                                                     |
| `object`   | `enum ('model')` | Yes      | Object type; always `model`. (default: model)                                                                                 |
| `created`  | `integer`        | Yes      | Unix timestamp (seconds) at which the model was created.                                                                      |
| `owned_by` | `string`         | Yes      | Owner of the model.                                                                                                           |
| `metadata` | `object`         | No       | Client-specific metadata, present only when the request supplies a recognized `client` query parameter. Keyed by client type. |
