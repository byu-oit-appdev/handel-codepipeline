/*
 * Copyright 2017 Brigham Young University
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
import * as AWS from 'aws-sdk';
import { AccountConfig } from 'handel/src/datatypes';
import { Question } from 'inquirer';
import * as yaml from 'js-yaml';
import { ParsedArgs } from 'minimist';
import * as winston from 'winston';
import * as iamCalls from '../aws/iam-calls';
import * as s3Calls from '../aws/s3-calls';
import * as util from '../common/util';
import { HandelCodePipelineFile, PhaseDeployers, PhaseSecretQuestion, PhaseSecrets } from '../datatypes/index';
import * as input from '../input';
import * as lifecycle from '../lifecycle';

function configureLogger(argv: ParsedArgs) {
    let level = 'info';
    if (argv.d) {
        level = 'debug';
    }
    winston!.level = level;
    winston.cli();
}

function getCodePipelineBucketName(accountConfig: AccountConfig) {
    return `codepipeline-${accountConfig.region}-${accountConfig.account_id}`;
}

function validatePipelineSpec(handelCodePipelineFile: HandelCodePipelineFile) {
    const validateErrors = lifecycle.validatePipelineSpec(handelCodePipelineFile);
    if (validateErrors.length > 0) {
        winston.error('Errors while validating handel-codepipeline.yml file:');
        winston.error(validateErrors.join('\n'));
        process.exit(1);
    }
}

function checkPhases(handelCodePipelineFile: HandelCodePipelineFile, phaseDeployers: PhaseDeployers) {
    const pipelinePhaseErrors = lifecycle.checkPhases(handelCodePipelineFile, phaseDeployers);
    let hadErrors = false;
    for (const pipelineName in pipelinePhaseErrors) {
        if (pipelinePhaseErrors.hasOwnProperty(pipelineName)) {
            const pipelineErrors = pipelinePhaseErrors[pipelineName];
            if (pipelineErrors.length > 0) {
                winston.error(`Errors in pipeline '${pipelineName}': `);
                winston.error(pipelineErrors.join('\n'));
                hadErrors = true;
            }
        }
    }

    if (hadErrors) {
        winston.error('Errors were found while validating your Handel-CodePipeline file');
        process.exit(1);
    }
}

async function validateCredentials(accountConfig: AccountConfig) {
    const deployAccount = accountConfig.account_id;
    winston.debug(`Checking that current credentials match account ${deployAccount}`);
    const discoveredId = await iamCalls.showAccount();
    winston.debug(`Currently logged in under account ${discoveredId}`);
    if (!discoveredId) {
        winston.error(`You are not logged into the account ${deployAccount}`);
        process.exit(1);
    }
    else if (deployAccount === discoveredId) {
        return;
    }
    else {
        winston.error(`You are trying to deploy to the account ${deployAccount}, but you are logged into the account ${discoveredId}`);
        process.exit(1);
    }
}

export async function deployAction(handelCodePipelineFile: HandelCodePipelineFile, argv: ParsedArgs) {
    configureLogger(argv);
    const phaseDeployers = util.getPhaseDeployers();
    validatePipelineSpec(handelCodePipelineFile);
    checkPhases(handelCodePipelineFile, phaseDeployers);
    const nonInteractive = (argv.pipeline && argv.account_name && argv.secrets);

    try {
        if(!nonInteractive) {
            winston.info('Welcome to the Handel CodePipeline setup wizard');
        }
        const pipelineConfig = await input.getPipelineConfigForDeploy(argv);
        const accountName = pipelineConfig.accountName;
        const accountConfig = util.getAccountConfig(pipelineConfig.accountConfigsPath, accountName);
        winston.debug(`Using account config: ${JSON.stringify(accountConfig)}`);

        await validateCredentials(accountConfig);
        AWS.config.update({ region: accountConfig.region });
        const pipelineName = pipelineConfig.pipelineToDeploy;

        if (!handelCodePipelineFile.pipelines[pipelineName]) {
            throw new Error(`The pipeline '${pipelineName}' you specified doesn't exist in your Handel-Codepipeline file`);
        }
        const codePipelineBucketName = getCodePipelineBucketName(accountConfig);
        const bucket = await s3Calls.createBucketIfNotExists(codePipelineBucketName, accountConfig.region);
        let phasesSecrets;
        if(nonInteractive) {
            phasesSecrets = lifecycle.getSecretsFromArgv(handelCodePipelineFile, argv);
        } else {
            phasesSecrets = await lifecycle.getPhaseSecrets(phaseDeployers, handelCodePipelineFile, pipelineName);
        }
        const pipelinePhases = await lifecycle.deployPhases(phaseDeployers, handelCodePipelineFile, pipelineName, accountConfig, phasesSecrets, codePipelineBucketName);
        const pipeline = await lifecycle.deployPipeline(handelCodePipelineFile, pipelineName, accountConfig, pipelinePhases, codePipelineBucketName);
        const webhook = await lifecycle.addWebhooks(phaseDeployers, handelCodePipelineFile, pipelineName, accountConfig, codePipelineBucketName);
        winston.info(`Finished creating pipeline in ${accountConfig.account_id}`);

    } catch(err) {
        winston.error(`Error setting up Handel CodePipeline: ${err.message}`);
        winston.error(err);
    }
}

export function checkAction(handelCodePipelineFile: HandelCodePipelineFile, argv: ParsedArgs) {
    configureLogger(argv);
    const phaseDeployers = util.getPhaseDeployers();
    validatePipelineSpec(handelCodePipelineFile);
    checkPhases(handelCodePipelineFile, phaseDeployers);
    winston.info('No errors were found in your Handel-CodePipeline file');
}

export async function deleteAction(handelCodePipelineFile: HandelCodePipelineFile, argv: ParsedArgs) {
    configureLogger(argv);
    if(!(argv.pipeline && argv.account_name)) {
        winston.info('Welcome to the Handel CodePipeline deletion wizard');
    }

    const phaseDeployers = util.getPhaseDeployers();

    const pipelineConfig = await input.getPipelineConfigForDelete(argv);
    const accountName = pipelineConfig.accountName;
    const accountConfig = util.getAccountConfig(pipelineConfig.accountConfigsPath, accountName);

    await validateCredentials(accountConfig);
    AWS.config.update({ region: accountConfig.region });
    const codePipelineBucketName = getCodePipelineBucketName(accountConfig);
    const pipelineName = pipelineConfig.pipelineToDelete;
    const appName = handelCodePipelineFile.name;

    try {
        const deleteWebhook = await lifecycle.removeWebhooks(phaseDeployers, handelCodePipelineFile, pipelineName, accountConfig, codePipelineBucketName);
        const deleteResult = await lifecycle.deletePipeline(appName, pipelineName);
        return lifecycle.deletePhases(phaseDeployers, handelCodePipelineFile, pipelineName, accountConfig, codePipelineBucketName);
    }
    catch (err) {
        winston.error(`Error deleting Handel CodePipeline: ${err}`);
        winston.error(err);
    }
}

export async function listSecretsAction(handelCodePipelineFile: HandelCodePipelineFile, argv: ParsedArgs) {
    if(!argv.pipeline) {
        winston.error('The --pipeline argument is required');
        process.exit(1);
    }
    if (!handelCodePipelineFile.pipelines[argv.pipeline]) {
        throw new Error(`The pipeline '${argv.pipeline}' you specified doesn't exist in your Handel-Codepipeline file`);
    }
    const phaseDeployers = util.getPhaseDeployers();
    const phaseDeployerSecretsQuestions: PhaseSecretQuestion[] = [];
    const pipelineConfig = handelCodePipelineFile.pipelines[argv.pipeline];
    for(const phaseConfig of pipelineConfig.phases) {
        const phaseDeployer = phaseDeployers[phaseConfig.type];
        const questions = phaseDeployer.getSecretQuestions(phaseConfig);
        questions.forEach((question: PhaseSecretQuestion) => {
            phaseDeployerSecretsQuestions.push(question);
        });
        // phaseDeployerSecretsQuestions.concat(questions);
    }
    // tslint:disable-next-line:no-console
    console.log(JSON.stringify(phaseDeployerSecretsQuestions));
}
