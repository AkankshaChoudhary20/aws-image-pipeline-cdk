// Runs before the test framework loads. Sets dummy credentials and disables
// the EC2 instance metadata credential provider so the AWS SDK clients
// constructed by the handler never attempt a real network call while
// resolving credentials (which, off EC2, can take minutes to time out).
// All AWS calls in the tests themselves are intercepted by aws-sdk-client-mock.
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test';
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
process.env.AWS_EC2_METADATA_DISABLED = 'true';
