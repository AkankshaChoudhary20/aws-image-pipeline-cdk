import type { S3Handler, S3EventRecord } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const TABLE_NAME = process.env.RESULTS_TABLE_NAME ?? '';
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-3-haiku-20240307-v1:0';

const s3Client = new S3Client({ region: REGION });
const bedrockClient = new BedrockRuntimeClient({ region: REGION });
const ddbDocClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
);

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export type ProcessingStatus = 'completed' | 'failed';

export interface ResultRecord {
  imageKey: string;
  status: ProcessingStatus;
  caption?: string;
  tags?: string[];
  errorMessage?: string;
  timestamp: string;
}

function getExtension(key: string): string {
  const parts = key.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * Parses the free-form caption text returned by the model into a short
 * caption plus a handful of comma-separated tags. The model is prompted to
 * respond in "caption | tag1, tag2, tag3" form; if it doesn't, the whole
 * response is used as the caption and no tags are extracted.
 */
export function parseCaptionAndTags(rawText: string): {
  caption: string;
  tags: string[];
} {
  const trimmed = rawText.trim();
  const separatorIndex = trimmed.indexOf('|');
  if (separatorIndex === -1) {
    return { caption: trimmed, tags: [] };
  }
  const caption = trimmed.slice(0, separatorIndex).trim();
  const tags = trimmed
    .slice(separatorIndex + 1)
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return { caption, tags };
}

async function writeResult(result: ResultRecord): Promise<void> {
  await ddbDocClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: result,
    }),
  );
}

async function invokeBedrockForCaption(
  imageBytes: Uint8Array,
  mediaType: string,
): Promise<{ caption: string; tags: string[] }> {
  const base64Image = Buffer.from(imageBytes).toString('base64');

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Image,
            },
          },
          {
            type: 'text',
            text:
              'Describe this image in one short sentence, then list 3-6 ' +
              'single-word tags. Respond in exactly this format with no ' +
              'other text: "<caption> | <tag1>, <tag2>, <tag3>"',
          },
        ],
      },
    ],
  };

  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }),
  );

  const responseBody = JSON.parse(Buffer.from(response.body).toString('utf-8'));
  const rawText: string = responseBody?.content?.[0]?.text ?? '';
  return parseCaptionAndTags(rawText);
}

async function processRecord(record: S3EventRecord): Promise<void> {
  const bucket = record.s3.bucket.name;
  // S3 keys in event notifications are URL-encoded (e.g. spaces become '+').
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const timestamp = new Date().toISOString();

  const extension = getExtension(key);
  const mediaType = SUPPORTED_EXTENSIONS[extension];

  if (!mediaType) {
    console.warn(`Unsupported file type for key "${key}" (.${extension})`);
    await writeResult({
      imageKey: key,
      status: 'failed',
      errorMessage: `Unsupported file type: .${extension || 'unknown'}`,
      timestamp,
    });
    return;
  }

  try {
    const getObjectResponse = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const imageBytes = await getObjectResponse.Body?.transformToByteArray();
    if (!imageBytes) {
      throw new Error('Empty object body returned from S3');
    }

    const { caption, tags } = await invokeBedrockForCaption(
      imageBytes,
      mediaType,
    );

    await writeResult({
      imageKey: key,
      status: 'completed',
      caption,
      tags,
      timestamp,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error(`Failed to process "${key}": ${errorMessage}`);
    await writeResult({
      imageKey: key,
      status: 'failed',
      errorMessage,
      timestamp,
    });
  }
}

export const handler: S3Handler = async (event) => {
  // Process records independently: one bad/throttled image should not stop
  // the rest of the batch, and every outcome (success or failure) is
  // recorded in DynamoDB rather than left unaccounted for.
  const results = await Promise.allSettled(
    event.Records.map((record) => processRecord(record)),
  );

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    console.error(
      `${failures.length}/${results.length} records raised unexpected errors outside processRecord's own handling.`,
    );
  }
};
