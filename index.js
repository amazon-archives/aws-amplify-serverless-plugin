// Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require('fs');
const chalk = require('chalk');

class ServerlessAmplifyPlugin {
    constructor(serverless, options) {
        this.useragent = 'serverless-amplify-plugin/0.0.1';
        this.serverless = serverless;
        this.options = options;
        this.provider = this.serverless.getProvider('aws');
        this.hooks = {
            'after:deploy:deploy': this.process.bind(this)
        };
        this.config = this.serverless.service.custom.amplify;
    }

    /**
     * Constructs the AWS CloudFormation stack name
     */
    get stackName() {
        const serviceName = this.serverless.service.getServiceName();
        return `${serviceName}-${this.stage}`;
    }

    /**
     * Obtains the primary region used to deploy this CloudFormation stack
     */
    get region() {
        return this.provider.getRegion();
    }

    /**
     * Obtain the deployment stage.
     */
    get stage() {
        return this.provider.getStage();
    }

    /**
     * Log a message to the console.
     */
    log(level, message) {
        if (level == 'error') {
            console.log(chalk.red(`ERROR: amplify-plugin: ${message}`));
        } else if (level == 'warn') {
            console.log(chalk.yellow(`WARNING: amplify-plugin: ${message}`));
        } else if (level == 'info') {
            if (this.options.v) console.log(chalk.green('amplify-plugin: ') + message);
        } else {
            if (process.env.SLS_DEBUG) console.log(chalk.blue('amplify-plugin: ') + message);
        }
    }

    /**
     * Calls the AWS Control Plane API to retrieve information
     *
     * @param {String} apiName
     * @param {String} operation
     * @param {Object} parameters
     */
    fetch(apiName, operation, parameters) {
        this.log('debug', `fetch(${apiName}, ${operation}, ${JSON.stringify(parameters)})`);
        return this.provider.request(apiName, operation, parameters);
    }

    /**
     * Fetch a list of all the resources in the stack, processing the paged response
     */
    async fetchStackResources() {
        let resources = [];
        let request = { StackName: this.stackName };
        let morePages = false;

        do {
            let result = await this.fetch('CloudFormation', 'listStackResources', request);
            result.StackResourceSummaries.forEach(item => { resources.push(item); });
            request.NextToken = result.NextToken;
            morePages = result.nextToken ? true : false;
        } while (morePages);

        return Promise.all(resources);
    }

    /**
     * Process an AWS AppSync API to generate the appropriate configuration
     *
     * @param {AWSResource} resource the resource record for the AppSync API
     */
    async fetchAppsyncResource(resource) {
        this.log('debug', `Processing AWS AppSync API ${resource.LogicalResourceId}`);
        const apiId = resource.PhysicalResourceId.split('/')[1];
        let result = await this.fetch('AppSync', 'getGraphqlApi', { apiId });
        let schemaResult = await this.fetch('AppSync', 'getIntrospectionSchema', { apiId, format: 'JSON' });
        let schema = JSON.parse(schemaResult.schema.toString())
        return {
            'AppSync': {
                'ApiUrl': result.graphqlApi.uris.GRAPHQL,
                'AuthMode': result.graphqlApi.authenticationType,
                'Region': result.graphqlApi.arn.split(':')[3]
            },
            'AppSyncSchema': schema
        };
    }

    /**
     * Process an Amazon Cognito User Pool to generate the appropriate configuration.  Unlike other
     * resources, we have to take care of the user pool and the app client.
     *
     * @param {AWSResource} resource the resource record for the Cognito user pool
     * @param {AWSResource[]} resources the list of all resources
     */
    async fetchCognitoUserPoolResource(resource, resources) {
        // If we have not fetch the user pool yet, do so now.
        if (!this.cognitoUserPool) {
            const rr = resources.filter(r => r.ResourceType === 'AWS::Cognito::UserPool');
            this.log('debug', `Processing Amazon Cognito User Pool ${rr[0].LogicalResourceId}`);
            let userpool = await this.fetch('CognitoIdentityServiceProvider', 'describeUserPool', {
                UserPoolId: rr[0].PhysicalResourceId
            });
            this.cognitoUserPool = {
                'PoolId': userpool.UserPool.Id,
                'Region': userpool.UserPool.Arn.split(':')[3]
            };
        }

        this.log('debug', `Processing Amazon Cognito App Client ${resource.LogicalResourceId}`);
        let result = await this.fetch('CognitoIdentityServiceProvider', 'describeUserPoolClient', {
            ClientId: resource.PhysicalResourceId, UserPoolId: this.cognitoUserPool.PoolId
        });

        let config = {};
        config[resource.LogicalResourceId] = Object.assign({}, this.cognitoUserPool, {
            'AppClientId': result.UserPoolClient.ClientId,
            'AppClientSecret': result.UserPoolClient.ClientSecret
        });
        return config;
    }

    /**
     * Process an Amazon Cognito Identity Pool resource to generate the appropriate configuration
     *
     * @param {AWSResource} resource the resource record for the Identity Pool
     */
    fetchCognitoIdentityPoolResource(resource) {
        this.log('debug', `Processing Amazon Cognito Identity Pool ${resource.LogicalResourceId}`);
        return {
            'CognitoIdentity': {
                'PoolId': resource.PhysicalResourceId,
                'Region': this.region
            }
        };
    }

    /**
     * Process and S3 Bucket to generate the appropriate configuration
     *
     * @param {AWSResource} resource the resource record for the S3 Bucket
     */
    fetchS3BucketResource(resource) {
        this.log('debug', `Processing Amazon S3 Bucket ${resource.LogicalResourceId}`);
        return {
            'S3TransferUtility': {
                'Bucket': resource.PhysicalResourceId,
                'Region': this.region
            }
        };
    }

    /**
     * Fetches a combined list of all resources and their necessary configurations
     */
    async fetchResourceConfigurations() {
        let resources = await this.fetchStackResources();
        let responses = [];

        resources.forEach(resource => {
            switch (resource.ResourceType) {
                case 'AWS::AppSync::GraphQLApi':
                    responses.push(this.fetchAppsyncResource(resource));
                    break;
                case 'AWS::Cognito::IdentityPool':
                    responses.push(this.fetchCognitoIdentityPoolResource(resource));
                    break;
                case 'AWS::Cognito::UserPoolClient':
                    responses.push(this.fetchCognitoUserPoolResource(resource, resources));
                    break;
                case 'AWS::S3::Bucket':
                    if (resource.LogicalResourceId !== 'ServerlessDeploymentBucket') {
                        responses.push(this.fetchS3BucketResource(resource));
                    }
                    break;
            }
        });
        return Promise.all(responses);
    }

    /**
     * Process the after:deploy:deploy hook to generate the files
     */
    process() {
        this.fetchResourceConfigurations()
        .then(responses => { return Object.assign({}, ...responses); })
        .then(configuration => { this.writeConfigurationFiles(configuration); })
        .catch(error => { this.log('error', `Cannot load resources: ${error.message}`); });
    }

    /**
     * Fetches the appropriate app client record
     *
     * @param {Object} configuration the configuration to process
     * @param {String} appClient the name of the appclient
     */
    fetchAppClient(configuration, appClient) {
        if (appClient && configuration.hasOwnProperty(appClient)) {
            return configuration[appClient];
        } else {
            return undefined;
        }
    }

    /**
     * Converts the configuration to a native configuration format with the appropriate app client
     *
     * @param {Object} configuration the configuration to process
     * @param {String} appClient the application client (undefined allowed)
     */
    toNativeConfiguration(configuration, appClient) {
        let config = {
            'UserAgent': this.useragent,
            'Version': '1.0'
        };

        let authconfig = this.fetchAppClient(configuration, appClient);
        if (authconfig) {
            config.CognitoUserPool = { 'Default': authconfig };
        }

        if (configuration.hasOwnProperty('CognitoIdentity')) {
            config.CredentialsProvider = { 'CognitoIdentity': { 'Default': configuration.CognitoIdentity } };
        }

        if (configuration.hasOwnProperty('AppSync')) {
            config.AppSync = { 'Default': configuration.AppSync };
        }

        if (configuration.hasOwnProperty('S3TransferUtility')) {
            config.S3TransferUtility = { 'Default': configuration.S3TransferUtility };
        }

        return JSON.stringify(config, null, 2);
    }

    /**
     * Converts the configuration to a JavaScript configuration format with the appropriate app client
     *
     * @param {Object} configuration the configuration to process
     * @param {String} appClient the application client (undefined allowed)
     */
    toJavascriptConfiguration(configuration, appClient) {
        let config = [
            '// WARNING: DO NOT EDIT.  This file is automatically generated',
            `// Written by ${this.useragent} on ${new Date().toISOString()}`,
            '',
            'const awsmobile = {',
            `    "aws_project_region": "${this.region}",`
        ];

        let authconfig = this.fetchAppClient(configuration, appClient);
        if (authconfig) {
            config.push(
                `    "aws_cognito_region": "${authconfig.Region}",`,
                `    "aws_user_pools_id": "${authconfig.PoolId}",`,
                `    "aws_user_pools_web_client_id": "${authconfig.AppClientId}",`
            );
            if (authconfig.AppClientSecret) {
                config.push(`    "aws_user_pools_web_client_secret": "${authconfig.AppClientSecret}",`);
            }
        }

        if (configuration.hasOwnProperty('CognitoIdentity')) {
            if (!authconfig) { config.push(`    "aws_cognito_region": "${configuration.CognitoIdentity.Region}",`); }
            config.push(`    "aws_cognito_identity_pool_id": "${configuration.CognitoIdentity.PoolId}",`);
        }

        if (configuration.hasOwnProperty('AppSync')) {
            config.push(
                `    "aws_appsync_graphqlEndpoint": "${configuration.AppSync.ApiUrl}",`,
                `    "aws_appsync_region": "${configuration.AppSync.Region}",`,
                `    "aws_appsync_authenticationType": "${configuration.AppSync.AuthMode}",`
            );
        }

        if (configuration.hasOwnProperty('S3TransferUtility')) {
            config.push(
                `    "aws_user_files_s3_bucket": "${nativeConfig.S3TransferUtility.Bucket}",`
                `    "aws_user_files_s3_bucket_region": "${nativeConfig.S3TransferUtility.Region}",`
            );
        }

        config.push('};', '', 'export default awsmobile;', '');
        return config.join("\n");
    }

    /**
     * Write a file to the filesystem
     *
     * @param {String} filename the file name to write to - any intermediary directories must exist
     * @param {String} contents the contents of the file
     */
    writeConfigurationFile(filename, contents) {
        fs.writeFile(filename, contents, 'utf8', (err, data) => {
            if (err) {
                this.log('error', `Writing to ${filename}: ${err}`);
            }
        });
    }

    /**
     * Process the configuration, writing the appropriate configuration file to each location
     *
     * @param {Configuration} configuration the generated configuration object
     */
    writeConfigurationFiles(configuration) {
        this.config.forEach(fileDetails => {
            switch (fileDetails.type.toLowerCase()) {
                case 'native':
                    this.log('info', `Writing native configuration to ${fileDetails.filename}`);
                    let nativeConfig = this.toNativeConfiguration(configuration, fileDetails.appClient);
                    this.writeConfigurationFile(fileDetails.filename, nativeConfig);
                    break;
                case 'javascript':
                    this.log('info', `Writing Javascript configuration to ${fileDetails.filename}`);
                    let jsConfig = this.toJavascriptConfiguration(configuration, fileDetails.appClient);
                    this.writeConfigurationFile(fileDetails.filename, jsConfig);
                    break;
                case 'schema.json':
                    if (configuration.hasOwnProperty('AppSyncSchema')) {
                        this.log('info', `Writing schema.json file to ${fileDetails.filename}`);
                        this.writeConfigurationFile(fileDetails.filename, JSON.stringify(configuration.AppSyncSchema, null, 2));
                    } else {
                        this.log('error', 'Schema.json was requested, but not available in configuration');
                    }
                    break;
                default:
                    this.log('warn', `Skipping entry: ${JSON.stringify(fileDetails)} - missing or unknown type field`);
                    break;
            }
        });
    }
}

module.exports = ServerlessAmplifyPlugin;
