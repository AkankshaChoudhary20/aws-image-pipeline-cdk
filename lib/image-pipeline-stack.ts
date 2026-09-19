import * as path from 'path';
import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Serverless, event-driven image processing pipeline.
 *
 * Flow: an object uploaded to the S3 bucket triggers a Lambda function,
 * which asks a multimodal model on Amazon Bedrock to caption/tag the image
 * and records the outcome (including failures) in a DynamoDB table.
 */
export class ImagePipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- S3 bucket for uploads -------------------------------------------
    const uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    // --- DynamoDB table for processing results ----------------------------
    const resultsTable = new dynamodb.Table(this, 'ResultsTable', {
      partitionKey: { name: 'imageKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: false,
    });

    // --- Lambda function ----------------------------------------------------
    const bedrockModelId =
      this.node.tryGetContext('bedrockModelId') ??
      'anthropic.claude-3-haiku-20240307-v1:0';

    const processImageFn = new lambdaNodejs.NodejsFunction(
      this,
      'ProcessImageFunction',
      {
        entry: path.join(__dirname, '..', 'lambda', 'process-image', 'index.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        memorySize: 512,
        timeout: Duration.seconds(30),
        environment: {
          RESULTS_TABLE_NAME: resultsTable.tableName,
          BEDROCK_MODEL_ID: bedrockModelId,
        },
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'node20',
        },
      },
    );

    // --- Least-privilege permissions, via CDK grant methods ----------------

    // Read-only access to the objects the function needs to caption.
    uploadBucket.grantRead(processImageFn);

    // Write-only access to the results table (no read/delete needed).
    resultsTable.grantWriteData(processImageFn);

    // Bedrock has no CDK `grant*` helper, so the least-privilege policy is
    // scoped explicitly to InvokeModel on the one foundation model this
    // function uses, in this account/region, rather than "bedrock:*"/"*".
    processImageFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:${this.partition}:bedrock:${this.region}::foundation-model/${bedrockModelId}`,
        ],
      }),
    );

    // --- S3 -> Lambda event notification -----------------------------------
    uploadBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(processImageFn),
    );
  }
}
