#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImagePipelineStack } from '../lib/image-pipeline-stack';

const app = new cdk.App();

// Environment-agnostic by default: no AWS account/credentials are needed to
// run `cdk synth` in this repo. Pass CDK_DEFAULT_ACCOUNT/CDK_DEFAULT_REGION
// (set automatically by the CDK CLI when you're logged into an account) or
// -c account=... -c region=... at deploy time to target a real account.
new ImagePipelineStack(app, 'AwsImagePipelineStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
