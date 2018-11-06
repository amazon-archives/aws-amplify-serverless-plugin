# AWS Amplify Plugin for Serverless Framework

This is a plugin for the [Serverless Framework](https://serverless.com) that generates appropriate configuration files for using [AWS Amplify](https://aws-amplify.github.io) with the Serverless Framework.

## Installation

Install the plugin via Yarn (recommended)

```
yarn add aws-amplify-serverless-plugin
```

or via NPM

```
npm install --save aws-amplify-serverless-plugin
```

## Configuration

Edit your `serverless.yml` file to include something like the following:

```
plugins:
  - aws-amplify-serverless-plugin

custom:
  amplify:
    - filename: examples/awsconfiguration.json
      type: native
      appClient: AndroidUserPoolClient
      s3bucket: UserFiles
    - filename: examples/schema.json
      type: schema.json
    - filename: examples/aws-exports.js
      type: javascript
      appClient: WebUserPoolClient
      s3bucket: disabled
```

Each entry in the `amplify` section must consist of two parts, with two optional parts:

* `filename` is where you want the file to be stored.  The directory must already exist.
* `type` is one of the following:
    * `native` (an `awsconfiguration.json` type file),
    * `javascript` (an `aws-exports.js` type file),
    * `schema.json` (the AWS AppSync schema in JSON format),
    * `graphql` (a sample GraphQL operations file for codegen),
    * `appsync` (generated code for AppSync - the format is based on the extension)
* `appClient` is the name of the Amazon Cognito user pool app client configured within the `resources` section of the `serverless.yml` file.  It is optional.
* `s3bucket` is the name of the S3 Bucket used for the S3 transfer utility.  It is optional.  If `disabled`, no S3 bucket information is written to the configuration file.  If not included, the first non-deployed S3 bucket will be used.

For the `appsync` type, the extension of the file is checked.  Supported formats include `flow`, `ts` (for TypeScript), `scala`, and `swift`.

See the `example` directory for a complete sample of an AWS AppSync client deployment with Amazon Cognito user pools.

### Another Example

Let's say you had four directories in your GitHub repository - one for the backend, one for your Android app in `android`, one for your iOS app in `ios` and one for your web resources in `web`, you could add the following to the `backend/serverless.yml` file:

```
plugins:
  - aws-amplify-serverless-plugin

custom:
  amplify:
    - filename: ../android/app/src/main/res/raw/awsconfiguration.json
      type: native
      appClient: AndroidUserPoolClient
    - filename: ../ios/MyApp/awsconfiguration.json
      type: native
      appClient: iOSUserPoolClient
    - filename: ../web/src/aws-exports.js
      type: javascript
      appClient: WebUserPoolClient
```

To deploy your backend and build all the clients, you might do the following:

```
$ (cd backend && sls deploy -v)
$ (cd android && ./gradlew build)
$ (cd ios && ./build)
$ (cd web && npm run deploy)
```

Once the deployment of the backend is done, the AWS configuration files needed for each of the builds will be updated.

**Note:** If you are generating a configuration file for an iOS build, ensure you do not "copy" the `awsconfiguration.json` file.  If you do, it will not be updated when the deployment happens.

## Support for GraphQL Code Generation (Android)

When you are configuring AWS AppSync for Android apps, you need three files.  In general,
these will be as follows:

```
plugins:
  - aws-amplify-serverless-plugin

custom:
  amplify:
    - filename: ../android/app/src/main/res/raw/awsconfiguration.json
      type: native
      appClient: AndroidUserPoolClient
    - filename: ../android/app/src/main/graphql/schema.json
      type: schema.json
    - filename: ../android/app/src/main/graphql/operations.graphql
      type: graphql
```

You can then follow the instructions within the [AWS AppSync Developers Guide](https://docs.aws.amazon.com/appsync/latest/devguide/building-a-client-app-android-overview.html) to implement the AWS AppSync client.  The files generated will match those that are produced by the [AWS Amplify](https://aws-amplify.github.io) CLI.

## Support for GraphQL Code Generation (iOS)

When you are configuring AWS AppSync for iOS apps, you need two files.  In general,
these will be as follows:

```
plugins:
  - aws-amplify-serverless-plugin

custom:
  amplify:
    - filename: ../ios/awsconfiguration.json
      type: native
      appClient: iOSUserPoolClient
    - filename: ../ios/GraphQLAPI.swift
      type: appsync
```

Add both files to your XCode project.  When prompted, **uncheck the Copy Items box**.  The plugin will maintain these files for you.  If you check the Copy Items box, then your project may not receive the updates if copied.  If you uncheck the box, these files will be updated whenever you deploy your resources.

You can then follow the instructions within the [AWS AppSync Developers Guide](https://docs.aws.amazon.com/appsync/latest/devguide/building-a-client-app-ios-overview.html) to implement the AWS AppSync client.  The files generated will match those that are produced by the [AWS Amplify](https://aws-amplify.github.io) CLI.

## Supported Resources

The following resources are supported:

* AWS AppSync (either via `resources` or the [serverless-appsync-plugin](https://github.com/sid88in/serverless-appsync-plugin)).
* Amazon Cognito federated identities.
  * Amazon Cognito User Pools
  * Google Signin
* Amazon Cognito user pools.
* S3 buckets for user file storage.

## Questions, Issues, Feature Requests

Check out the [issues tab](https://github.com/awslabs/aws-amplify-serverless-plugin/issues) at the top of the page!
