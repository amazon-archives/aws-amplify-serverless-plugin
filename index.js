// Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const graphqlGenerator = require('amplify-graphql-docs-generator').default;
const apiGenerator = require('aws-appsync-codegen');
const {
    name,
    version
} = require('./package.json');

class ServerlessAmplifyPlugin {
    constructor(serverless, options) {
        this.useragent = `${name}/${version}`;
        this.serverless = serverless;
        this.options = options;
        this.provider = this.serverless.getProvider('aws');
        this.hooks = {
            'after:deploy:deploy': this.process.bind(this)
        };
        this.stackName = `${this.serverless.service.getServiceName()}-${this.provider.getStage()}`;
        this.config = this.serverless.service.custom.amplify;
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
    async fetch(apiName, operation, parameters) {
        this.log('debug', `fetch(${apiName}, ${operation}, ${JSON.stringify(parameters)})`);
        return this.provider.request(apiName, operation, parameters);
    }

    /**
     * Process the after:deploy:deploy hook to generate the files.  Because the
     * process() has to be synchronous, yet many of the methods are async, we
     * transition to a Promise based structure.  However, most of the methods
     * use async/await to properly process things linearly.
     */
    process() {
        const resources = this.listStackResources(this.stackName)
            .then(resources => this.describeStackResources(resources))
            .then(resources => this.writeConfigurationFiles(resources))
            .catch(error => this.log('error', `Cannot load resources: ${error.message}`));
    }

    /**
     * Obtains the resources for a specific CloudFormation stack
     *
     * @param {String} stackName the name of the CloudFormation stack
     * @returns {Resource[]} list of resource objects
     */
    async listStackResources(stackName) {
        let resources = [];
        let request = { StackName: this.stackName };
        let morePages = false;

        do {
            let result = await this.fetch('CloudFormation', 'listStackResources', request);
            result.StackResourceSummaries.forEach(item => { resources.push(item); });
            request.NextToken = result.NextToken;
            morePages = result.NextToken ? true : false;
        } while (morePages);

        return resources;
    }

    /**
     * Gets the specifics of the actual physical resource ID based on the Resource Type
     *
     * @param {Resource[]} resources the list of resources to describe
     * @returns {Resource[]} the resource with added descriptions.
     */
    async describeStackResources(resources) {
        let detailedResources = [];
        for (let i = 0 ; i < resources.length ; i++) {
            const resource = resources[i];
            switch (resource.ResourceType) {
                case 'AWS::AppSync::GraphQLApi':
                    this.log('debug', `Processing ${JSON.stringify(resource)}`);
                    const appSyncId = resource.PhysicalResourceId.split('/')[1];
                    let appSyncMetaData = await this.fetch('AppSync', 'getGraphqlApi', { apiId: appSyncId });
                    let appSyncSchema = await this.fetch('AppSync', 'getIntrospectionSchema', { apiId: appSyncId, format: 'JSON' });
                    detailedResources.push(Object.assign({}, resource, { metadata: appSyncMetaData, schema:  JSON.parse(appSyncSchema.schema.toString()) }));
                    break;
                case 'AWS::Cognito::IdentityPool':
                    this.log('debug', `Processing ${JSON.stringify(resource)}`);
                    detailedResources.push(resource);   // We have all the details we need for this
                    break;
                case 'AWS::Cognito::UserPool':
                    this.log('debug', `Processing ${JSON.stringify(resource)}`);
                    const userPoolMetaData = await this.fetch('CognitoIdentityServiceProvider', 'describeUserPool', { UserPoolId: resource.PhysicalResourceId });
                    detailedResources.push(Object.assign({}, resource, { metadata: userPoolMetaData }));
                    break;
                case 'AWS::S3::Bucket':
                    this.log('debug', `Processing ${JSON.stringify(resource)}`);
                    detailedResources.push(resource);   // We have all the details we need for this
                    break;
            }
        }

        // Process User pool clients AFTER the user pool
        for (let i = 0 ; i < resources.length ; i++) {
            const resource = resources[i];
            switch (resource.ResourceType) {
                case 'AWS::Cognito::UserPoolClient':
                    this.log('debug', `Processing ${JSON.stringify(resource)}`);
                    const cfTemplate =  this.serverless.service.provider.compiledCloudFormationTemplate.Resources[resource.LogicalResourceId];
                    const userPoolName = cfTemplate.Properties.UserPoolId.Ref;
                    const userPoolResource = resources.filter(r => r.ResourceType === 'AWS::Cognito::UserPool' && r.LogicalResourceId === userPoolName)[0];
                    let result = await this.fetch('CognitoIdentityServiceProvider', 'describeUserPoolClient', {
                        ClientId: resource.PhysicalResourceId,
                        UserPoolId: userPoolResource.PhysicalResourceId
                    });
                    detailedResources.push(Object.assign({}, resource, { metadata: result }));
                    break;
            }
        }

        return detailedResources;
    }

    /**
     * Writes the schema file to a temporary location.
     *
     * @param {Resource} resource the GraphQL API Resource
     * @returns {String} path to the temporary file
     */
    getTemporarySchemaFile(resource) {
        const filename = path.join('.serverless', 'amplify-schema.json');
        fs.writeFileSync(filename, JSON.stringify(resource.schema, null, 2));
        return filename;
    }

    /**
     * Writes the operations file to a temporary location.
     *
     * @param {Resource} resource the GraphQL API Resource
     * @returns {String} path to the temporary file
     */
    getTemporaryOperationsFile(resource, schemaFile) {
        const operationsFile = path.join('.serverless', 'amplify-operations.graphql');
        graphqlGenerator(schemaFile, operationsFile, { language: 'graphql' });
        return operationsFile;
    }

    /**
     * Writes out the required configuration files.
     *
     * @param {Resource][]} resources the fully processed resources with all available data
     */
    writeConfigurationFiles(resources) {
        for (let i = 0 ; i < this.config.length ; i++) {
            const fileDetails = this.config[i];
            if (fileDetails.hasOwnProperty('type') && fileDetails.hasOwnProperty('filename')) {
                switch (fileDetails.type.toLowerCase()) {
                    case 'native':
                        this.log('info', `Writing ${fileDetails.type} file to ${fileDetails.filename}`);
                        this.writeNativeConfiguration(resources, fileDetails);
                        break;
                    case 'javascript':
                        this.log('info', `Writing ${fileDetails.type} file to ${fileDetails.filename}`);
                        this.writeJavaScriptConfiguration(resources, fileDetails);
                        break;
                    case 'schema.json':
                        this.log('info', `Writing ${fileDetails.type} file to ${fileDetails.filename}`);
                        this.writeSchemaJSONConfiguration(resources, fileDetails);
                        break;
                    case 'graphql':
                        this.log('info', `Writing ${fileDetails.type} file to ${fileDetails.filename}`);
                        this.writeGraphQLOperations(resources, fileDetails);
                        break;
                    case 'appsync':
                        this.log('info', `Writing ${fileDetails.type} file to ${fileDetails.filename}`);
                        this.writeAppSyncAPI(resources, fileDetails);
                        break;
                    default:
                        this.log('error', `Invalid Amplify configuration directive for ${JSON.stringify(fileDetails)}`);
                        throw new Error(`Invalid Amplify configuration directive for ${JSON.stringify(fileDetails)}`);
                }
            } else {
                this.log('error', `Invalid Amplify configuration directive for ${JSON.stringify(fileDetails)}`);
                throw new Error(`Invalid Amplify configuration directive for ${JSON.stringify(fileDetails)}`);
            }
        }
    }

    /**
     * Writes out a native 'awsconfiguration.json' file
     *
     * @param {Resource[]} resources the resources with meta-data
     * @param {FileDetails} fileDetails the file details
     */
    writeNativeConfiguration(resources, fileDetails) {
        let config = {
            'UserAgent': this.useragent,
            'Version': '1.0'
        };

        if (fileDetails.hasOwnProperty('appClient')) {
            const appClient = resources.find(r => r.ResourceType === 'AWS::Cognito::UserPoolClient' && r.LogicalResourceId === fileDetails.appClient);
            if (typeof appClient !== 'undefined') {
                config.CognitoUserPool = {
                    Default: {
                        PoolId: appClient.metadata.UserPoolClient.UserPoolId,
                        Region: appClient.metadata.UserPoolClient.UserPoolId.split('_')[0],
                        AppClientId: appClient.metadata.UserPoolClient.ClientId
                    }
                };
                if (appClient.metadata.UserPoolClient.hasOwnProperty('AppClientSecret')) {
                    config.CognitoUserPool.Default.AppClientSecret = appClient.metadata.UserPoolClient.ClientSecret
                }
            } else {
                throw new Error(`Invalid appClient specified: ${fileDetails.appClient}`);
            }
        }

        const identityPool = resources.find(r => r.ResourceType === 'AWS::Cognito::IdentityPool');
        if (typeof identityPool !== 'undefined') {
            config.CredentialsProvider = {
                CognitoIdentity: {
                    Default: {
                        Region: identityPool.PhysicalResourceId.split(':')[0],
                        PoolId: identityPool.PhysicalResourceId
                    }
                }
            };
        }

        const appSync = resources.find(r => r.ResourceType === 'AWS::AppSync::GraphQLApi');
        if (typeof appSync !== 'undefined') {
            config.AppSync = {
                Default: {
                    ApiUrl: appSync.metadata.graphqlApi.uris.GRAPHQL,
                    Region: appSync.metadata.graphqlApi.arn.split(':')[3],
                    AuthType: appSync.metadata.graphqlApi.authenticationType
                }
            };
        }

        let s3buckets = resources.filter(r => r.ResourceType === 'AWS::S3::Bucket' && r.LogicalResourceId !== 'ServerlessDeploymentBucket');
        if (s3buckets.length > 0) {
            let userFiles = fileDetails.hasOwnProperty('s3bucket') ? s3buckets.find(r => r.LogicalResourceId === fileDetails.s3bucket) : s3buckets[0];
            if (typeof userFiles !== 'undefined') {
                config.S3TransferUtility = {
                    Default: {
                        Bucket: userFiles.PhysicalResourceId,
                        Region: this.provider.getRegion()
                    }
                };
            }
        }

        this.writeConfigurationFile(fileDetails.filename, JSON.stringify(config, null, 2));
    }

    /**
     * Writes out a JavaScript 'aws-exports.js' file
     *
     * @param {Resource[]} resources the resources with meta-data
     * @param {FileDetails} fileDetails the file details
     */
    writeJavaScriptConfiguration(resources, fileDetails) {
        let config = [
            '// WARNING: DO NOT EDIT.  This file is automatically generated',
            `// Written by ${this.useragent} on ${new Date().toISOString()}`,
            '',
            'const awsmobile = {',
            `    "aws_project_region": "${this.provider.getRegion()}",`
        ];

        if (fileDetails.hasOwnProperty('appClient')) {
            const appClient = resources.find(r => r.ResourceType === 'AWS::Cognito::UserPoolClient' && r.LogicalResourceId === fileDetails.appClient);
            if (typeof appClient !== 'undefined') {
                config.push(
                    `    "aws_cognito_region": "${appClient.metadata.UserPoolClient.UserPoolId.split('_')[0]}",`,
                    `    "aws_user_pools_id": "${appClient.metadata.UserPoolClient.UserPoolId}",`,
                    `    "aws_user_pools_web_client_id": "${appClient.metadata.UserPoolClient.ClientId}",`
                );
                if (appClient.metadata.UserPoolClient.hasOwnProperty('AppClientSecret')) {
                    config.push(`    "aws_user_pools_web_client_secret": "${appClient.metadata.UserPoolClient.ClientSecret}",`);
                }
            } else {
                throw new Error(`Invalid appClient specified: ${fileDetails.appClient}`);
            }
        }

        const identityPool = resources.find(r => r.ResourceType === 'AWS::Cognito::IdentityPool');
        if (typeof identityPool !== 'undefined') {
            if (config.indexOf('"aws_cognito_region"') === -1) {
                config.push(`    "aws_cognito_region": "${identityPool.PhysicalResourceId.split(':')[0]}",`);
            }
            config.push(`    "aws_cognito_identity_pool_id": "${identityPool.PhysicalResourceId}",`);
        }

        const appSync = resources.find(r => r.ResourceType === 'AWS::AppSync::GraphQLApi');
        if (typeof appSync !== 'undefined') {
            config.push(
                `    "aws_appsync_graphqlEndpoint": "${appSync.metadata.graphqlApi.uris.GRAPHQL}",`,
                `    "aws_appsync_region": "${appSync.metadata.graphqlApi.arn.split(':')[3]}",`,
                `    "aws_appsync_authenticationType": "${appSync.metadata.graphqlApi.authenticationType}",`
            );
        }

        let s3buckets = resources.filter(r => r.ResourceType === 'AWS::S3::Bucket' && r.LogicalResourceId !== 'ServerlessDeploymentBucket');
        if (s3buckets.length > 0) {
            let userFiles = fileDetails.hasOwnProperty('s3bucket') ? s3buckets.find(r => r.LogicalResourceId === fileDetails.s3bucket) : s3buckets[0];
            if (typeof userFiles !== 'undefined') {
                config.push(
                    `    "aws_user_files_s3_bucket": "${userFiles.PhysicalResourceId}",`,
                    `    "aws_user_files_s3_bucket_region": "${this.provider.getRegion()}",`
                );
            }
        }

        config.push('};', '', 'export default awsmobile;', '');
        this.writeConfigurationFile(fileDetails.filename, config.join('\n'));
    }

    /**
     * Writes the schema.json type out to the file system.
     *
     * @param {Resource[]} resources the resources with meta-data
     * @param {FileDetails} fileDetails the file details
     */
    writeSchemaJSONConfiguration(resources, fileDetails) {
        // In Resources, find the AppSync GraphQL API and write the resource.schema out to a file
        const resource = resources.find(r => r.ResourceType === 'AWS::AppSync::GraphQLApi');
        if (resource) {
            this.writeConfigurationFile(fileDetails.filename, JSON.stringify(resource.schema, null, 2));
        } else {
            throw new Error('No GraphQL API found - cannot write schema.json file');
        }
    }

    /**
     * Writes out an 'operations.graphql' file of sample operations
     *
     * @param {Resource[]} resources the resources with meta-data
     * @param {FileDetails} fileDetails the file details
     */
    writeGraphQLOperations(resources, fileDetails) {
        const resource = resources.find(r => r.ResourceType === 'AWS::AppSync::GraphQLApi');
        if (resource) {
            const schemaFile = this.getTemporarySchemaFile(resource);
            graphqlGenerator(schemaFile, fileDetails.filename, { language: 'graphql' });
        } else {
            throw new Error(`No GraphQL API found - cannot write ${fileDetails.filename} file`);
        }
    }

    /**
     * Writes out an 'API.swift' file of sample operations
     *
     * @param {Resource[]} resources the resources with meta-data
     * @param {FileDetails} fileDetails the file details
     */
    writeAppSyncAPI(resources, fileDetails) {
        const resource = resources.find(r => r.ResourceType === 'AWS::AppSync::GraphQLApi');
        if (resource) {
            const schemaFile = path.resolve(this.getTemporarySchemaFile(resource));
            const graphqlFile = path.resolve(this.getTemporaryOperationsFile(resource, schemaFile));
            const fileType = path.extname(fileDetails.filename).substr(1);
            apiGenerator.generate(
                [ graphqlFile ],        /* List of GraphQL Operations */
                schemaFile,             /* Schema.json file */
                fileDetails.filename,   /* Output File */
                '',                     /* Only generate types */
                fileType,                /* Target Type */
                '',                     /* Tagname */
                '',                     /* Project Name */
                { addTypename: true }   /* Options */
            );
        } else {
            throw new Error(`No GraphQL API found - cannot write ${fileDetails.filename} file`);
        }
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
}

module.exports = ServerlessAmplifyPlugin;
