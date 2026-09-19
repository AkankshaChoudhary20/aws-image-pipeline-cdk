# aws-image-pipeline-cdk

A serverless, event-driven image processing pipeline: drop an image in S3,
and a Lambda function asks a multimodal model on Amazon Bedrock to caption
and tag it, then records the result in DynamoDB. The entire pipeline —
bucket, function, table, event wiring, and IAM — is defined as code with
AWS CDK v2 (TypeScript).

No servers, no queues, no polling: the S3 `ObjectCreated` event itself
invokes the function.

## Architecture

```
                 PutObject
   Uploader ───────────────────► S3 bucket (uploads)
                                       │
                                       │ ObjectCreated event notification
                                       ▼
                          ┌─────────────────────────┐
                          │   Lambda: process-image  │
                          │   (Node 20, TypeScript)  │
                          └─────────────────────────┘
                             │                    │
              GetObject      │                    │ InvokeModel
              (image bytes)  ▼                    ▼ (base64 image + prompt)
                     S3 bucket              Amazon Bedrock
                     (read-only)        (Anthropic Claude 3 Haiku,
                                          multimodal)
                                                   │
                                caption + tags,    │
                                or error detail     ▼
                                       ┌──────────────────────┐
                                       │   DynamoDB table      │
                                       │   (imageKey, status,  │
                                       │    caption, tags,     │
                                       │    timestamp)         │
                                       └──────────────────────┘
```

Every upload produces exactly one DynamoDB item — `status: "completed"`
with a caption and tags, or `status: "failed"` with an `errorMessage`
(unsupported file type, a Bedrock throttling error, etc.). Nothing is
dropped silently: a failure to caption an image is a recorded outcome, not
a crashed invocation.

## What it does

1. An image (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) is uploaded to the S3
   bucket.
2. The upload fires an `s3:ObjectCreated:*` event, which invokes the
   `ProcessImageFunction` Lambda directly (S3 → Lambda event notification,
   no SNS/SQS in between — there's exactly one consumer, so the extra
   fan-out plumbing wasn't worth it here).
3. The function downloads the object, base64-encodes it, and sends it to
   Bedrock (`anthropic.claude-3-haiku-20240307-v1:0` by default,
   overridable via CDK context) with a prompt asking for a one-sentence
   caption plus 3-6 tags.
4. The parsed caption/tags — or, on failure, the error — are written to
   DynamoDB, keyed by the S3 object key.

## Why these design choices

- **Direct S3 → Lambda notification, not EventBridge/SNS.** There is one
  producer and one consumer; a fan-out layer would add cost and latency
  with no consumer that needs it. If a second consumer shows up later
  (e.g. a thumbnail generator), that's the point at which to introduce
  EventBridge.
- **DynamoDB over RDS/Aurora.** Access pattern is a single get/put by
  `imageKey` — no joins, no ad-hoc queries. Pay-per-request billing means
  zero cost at zero traffic, which matters for a portfolio project that
  isn't meant to run 24/7.
- **IAM via CDK grant methods, not hand-written policy JSON.**
  `bucket.grantRead(fn)` and `table.grantWriteData(fn)` generate policies
  scoped to the exact actions and exact resource ARNs needed — no
  wildcards, no manually-maintained ARNs that drift from the actual
  resources. Bedrock has no CDK `grant*` helper (as of this writing), so
  that one statement is written explicitly, but still scoped to
  `bedrock:InvokeModel` on the single foundation-model ARN configured for
  this stack — not `"*"`.
- **Per-record failure isolation.** The handler processes every record in
  an S3 event with `Promise.allSettled`, and every code path — unsupported
  file type, S3 read failure, Bedrock throttling/error — ends in a
  DynamoDB write, never an uncaught throw. One bad image in a batch can't
  silently swallow the rest, and there's always a queryable record of what
  happened to a given key.
- **`NodejsFunction` (esbuild) over a hand-built deployment zip.** The
  Lambda is plain TypeScript with no build step of its own — CDK bundles
  and minifies it at `cdk synth`/`cdk deploy` time via esbuild, so the
  source of truth is one `.ts` file, not a compiled artifact checked into
  the repo.

## Verifying this project (no live AWS account used)

This repo was built and verified in a sandboxed dev environment with no
AWS account attached. Everything below was actually run and is honest
about what "verified" means here: the code is proven structurally correct
via synth + unit tests, **not** via a real deployment.

```bash
npm install
npm test        # Jest, mocks every AWS SDK client — no network calls
npx cdk synth   # renders the CloudFormation template locally — no AWS calls
```

- **`npm test`** — 5/5 passing. Covers the success path (valid image →
  Bedrock caption → `completed` item), the unsupported-file-type path
  (e.g. a `.pdf` → `failed` item, S3/Bedrock never called), and a Bedrock
  error path (a thrown `ThrottlingException` → `failed` item with the
  error message, handler does not throw). AWS SDK clients are mocked with
  `aws-sdk-client-mock`; no network calls are made.
- **`npx cdk synth`** — succeeds and prints a valid CloudFormation
  template for `AwsImagePipelineStack`. The stack is environment-agnostic
  (no hardcoded account/region), so synth needs no AWS credentials.

Deploying it for real is one command past that point, but wasn't done here
since there's no AWS account in this environment — see below.

## Deploying it for real

You'll need:

- An AWS account, with the CLI configured (`aws configure`) or credentials
  otherwise available to the CDK CLI.
- **Bedrock model access enabled** for the model you intend to use (by
  default `anthropic.claude-3-haiku-20240307-v1:0`) in your target region —
  this is a one-time opt-in per account/region under Bedrock → Model
  access in the AWS Console. `InvokeModel` fails with an access-denied
  error until this is granted.
- Node.js 20+.

```bash
npm install
npx cdk bootstrap   # one-time per account/region
npx cdk deploy
```

`cdk deploy` prints the bucket name and table name as stack outputs are
not currently exported — check the CloudFormation stack resources, or add
`CfnOutput`s if you want them surfaced directly. To try it end-to-end,
upload an image:

```bash
aws s3 cp ./some-photo.jpg s3://<bucket-name-from-stack>/
```

then check the result:

```bash
aws dynamodb get-item \
  --table-name <table-name-from-stack> \
  --key '{"imageKey": {"S": "some-photo.jpg"}}'
```

Tear down with `npx cdk destroy` — the bucket and table both have
`RemovalPolicy.DESTROY` (and `autoDeleteObjects` on the bucket) so nothing
is left behind billing you after you're done experimenting.

## Project layout

```
.
├── bin/
│   └── app.ts                       # CDK app entrypoint (environment-agnostic)
├── lib/
│   └── image-pipeline-stack.ts      # S3 + Lambda + DynamoDB + IAM, one stack
├── lambda/
│   └── process-image/
│       └── index.ts                 # handler: S3 event -> Bedrock -> DynamoDB
├── test/
│   └── process-image.test.ts        # Jest unit tests, mocked AWS SDK clients
├── cdk.json                          # CDK CLI config (app entrypoint, feature flags)
├── jest.config.js
├── tsconfig.json
└── package.json
```

## Caveats

- No thumbnail/resize step, no auth on the bucket beyond IAM (uploads are
  expected via the CLI/SDK, not a public form), no retry/DLQ wiring on the
  Lambda's S3 event source — a portfolio-scoped pipeline, not a production
  media platform. The natural next additions (an SQS DLQ on the event
  source mapping, a step to strip EXIF/GPS data before captioning) are
  deliberately left out to keep this project's scope to what's listed
  above.
- Bedrock model access and per-model pricing/quotas vary by account and
  region; this repo defaults to `anthropic.claude-3-haiku-20240307-v1:0`
  for cost, but the model ID is a CDK context value
  (`-c bedrockModelId=...`) so it's a one-line change to point at a
  different multimodal model on Bedrock.
