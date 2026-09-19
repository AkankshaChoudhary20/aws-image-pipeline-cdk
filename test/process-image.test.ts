import { mockClient } from 'aws-sdk-client-mock';
import type { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'stream';

process.env.RESULTS_TABLE_NAME = 'test-results-table';
process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';
process.env.AWS_REGION = 'us-east-1';

// Import after env vars are set, since the handler module reads them at
// module-load time to construct its SDK clients.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { handler, parseCaptionAndTags } from '../lambda/process-image';

const s3Mock = mockClient(S3Client);
const bedrockMock = mockClient(BedrockRuntimeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

function makeS3Event(key: string): S3Event {
  return {
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: 'us-east-1',
        eventTime: new Date().toISOString(),
        eventName: 'ObjectCreated:Put',
        s3: {
          s3SchemaVersion: '1.0',
          configurationId: 'test-config',
          bucket: {
            name: 'test-upload-bucket',
            ownerIdentity: { principalId: 'EXAMPLE' },
            arn: 'arn:aws:s3:::test-upload-bucket',
          },
          object: {
            key,
            size: 1024,
            eTag: 'abc123',
            sequencer: '0055AED6DCD90281E5',
          },
        },
      } as any,
    ],
  };
}

function bedrockResponseBody(text: string) {
  // Unlike S3's GetObject Body (a stream), InvokeModelCommand's response
  // body is a plain Uint8Array blob per the Bedrock Runtime API shape.
  const payload = JSON.stringify({ content: [{ type: 'text', text }] });
  return new TextEncoder().encode(payload);
}

function s3ObjectBody(bytes: Buffer) {
  return sdkStreamMixin(Readable.from([bytes]));
}

describe('parseCaptionAndTags', () => {
  it('splits "caption | tags" into a caption and a tag array', () => {
    const result = parseCaptionAndTags(
      'A golden retriever running on a beach | dog, beach, outdoors',
    );
    expect(result.caption).toBe('A golden retriever running on a beach');
    expect(result.tags).toEqual(['dog', 'beach', 'outdoors']);
  });

  it('falls back to using the whole response as the caption when there is no separator', () => {
    const result = parseCaptionAndTags('Just a plain sentence with no pipe');
    expect(result.caption).toBe('Just a plain sentence with no pipe');
    expect(result.tags).toEqual([]);
  });
});

describe('handler', () => {
  beforeEach(() => {
    s3Mock.reset();
    bedrockMock.reset();
    ddbMock.reset();
  });

  it('success path: captions a supported image and writes a completed result', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: s3ObjectBody(Buffer.from('fake-image-bytes')) as any,
    });
    bedrockMock.on(InvokeModelCommand).resolves({
      body: bedrockResponseBody(
        'A cat sitting on a windowsill | cat, window, indoor',
      ) as any,
    });
    ddbMock.on(PutCommand).resolves({});

    await handler(makeS3Event('uploads/cat.jpg'), {} as any, () => {});

    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(1);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item as any;
    expect(item.imageKey).toBe('uploads/cat.jpg');
    expect(item.status).toBe('completed');
    expect(item.caption).toBe('A cat sitting on a windowsill');
    expect(item.tags).toEqual(['cat', 'window', 'indoor']);
    expect(item.timestamp).toEqual(expect.any(String));
  });

  it('unsupported file type: writes a failed result without calling S3 or Bedrock', async () => {
    ddbMock.on(PutCommand).resolves({});

    await handler(makeS3Event('uploads/document.pdf'), {} as any, () => {});

    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item as any;
    expect(item.imageKey).toBe('uploads/document.pdf');
    expect(item.status).toBe('failed');
    expect(item.errorMessage).toMatch(/Unsupported file type/);
  });

  it('Bedrock error path: writes a failed result instead of throwing', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: s3ObjectBody(Buffer.from('fake-image-bytes')) as any,
    });
    bedrockMock
      .on(InvokeModelCommand)
      .rejects(
        Object.assign(new Error('Too many requests, please wait and try again later.'), {
          name: 'ThrottlingException',
        }),
      );
    ddbMock.on(PutCommand).resolves({});

    await expect(
      handler(makeS3Event('uploads/dog.png'), {} as any, () => {}),
    ).resolves.not.toThrow();

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item as any;
    expect(item.imageKey).toBe('uploads/dog.png');
    expect(item.status).toBe('failed');
    expect(item.errorMessage).toMatch(/Too many requests/);
  });
});
