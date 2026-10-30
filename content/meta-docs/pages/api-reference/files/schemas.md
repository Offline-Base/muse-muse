# Files schemas {#files-schemas}

The full schema and model definitions referenced by the [Files](https://dev.meta.ai/docs/api-reference/files/upload-file) endpoints. Each endpoint page links here for the detailed shape of its request and response objects.

## Schemas {#schemas}

### Create File Request {#create-file-request}

Request body for uploading a file. Uploaded files count toward one storage allowance that all applications and projects in your Team share. The default allowance is 100 GiB. A Team can have a different allowance. This request accepts only the `user_data` and `batch` purposes, and every upload it accepts counts.

| Field           | Type                                                                                          | Required | Description                                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file`          | `string (binary)`                                                                             | Yes      | The file to upload.                                                                                                                                                                                                                                                            |
| `purpose`       | `enum ('user_data', 'batch')`                                                                 | Yes      | The intended purpose of the uploaded file. Use `user_data` for files that requests reference, such as images and videos, and `batch` for Batch input files. OpenAI purposes that this endpoint does not serve, such as `fine-tune` and `evals`, are rejected with a 400 error. |
| `expires_after` | [`FileExpiresAfter`](https://dev.meta.ai/docs/api-reference/files/schemas#file-expires-after) | No       | Optional expiration policy, measured from file creation.                                                                                                                                                                                                                       |

### Delete File Response {#delete-file-response}

| Field     | Type            | Required | Description |
| --------- | --------------- | -------- | ----------- |
| `id`      | `string`        | Yes      |             |
| `object`  | `enum ('file')` | Yes      |             |
| `deleted` | `boolean`       | Yes      |             |

### File Expires After {#file-expires-after}

The expiration policy for an uploaded file.

| Field     | Type                  | Required | Description                                                                                          |
| --------- | --------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `anchor`  | `enum ('created_at')` | Yes      | The timestamp anchor for the expiration policy.                                                      |
| `seconds` | `integer (int64)`     | Yes      | The number of seconds after the anchor time when the file expires. (minimum: 3600, maximum: 2592000) |

### File Object {#file-object}

Represents a file uploaded to the Files API.

| Field            | Type                                                | Required | Description                                                                                                                                                                       |
| ---------------- | --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `string`                                            | Yes      | Identifier for the file. Format is `file-<numeric>`.                                                                                                                              |
| `bytes`          | `integer (int64)`                                   | Yes      | Size of the file in bytes.                                                                                                                                                        |
| `created_at`     | `integer (int64)`                                   | Yes      | Unix timestamp (seconds) for when the file was created.                                                                                                                           |
| `expires_at`     | `integer (int64)` \| `null`                         | Yes      | Unix timestamp (seconds) at which the file expires. An explicit policy uses `created_at + expires_after.seconds`. Non-expiring files return null rather than omitting this field. |
| `filename`       | `string`                                            | Yes      | Name of the file.                                                                                                                                                                 |
| `object`         | `enum ('file')`                                     | Yes      | Object type; always `file`.                                                                                                                                                       |
| `purpose`        | `enum ('batch', 'fine-tune', 'evals', 'user_data')` | Yes      | The intended purpose of the file.                                                                                                                                                 |
| `status`         | `enum ('uploaded', 'processed', 'error')`           | Yes      | Deprecated. The current status of the file, which can be either `uploaded`, `processed`, or `error`.                                                                              |
| `status_details` | `string`                                            | No       | Deprecated. Details about why the file failed validation.                                                                                                                         |

### List Files Response {#list-files-response}

| Field      | Type                                                                                      | Required | Description |
| ---------- | ----------------------------------------------------------------------------------------- | -------- | ----------- |
| `object`   | `enum ('list')`                                                                           | Yes      |             |
| `data`     | array of [`FileObject`](https://dev.meta.ai/docs/api-reference/files/schemas#file-object) | Yes      |             |
| `first_id` | `string`                                                                                  | Yes      |             |
| `last_id`  | `string`                                                                                  | Yes      |             |
| `has_more` | `boolean`                                                                                 | Yes      |             |
