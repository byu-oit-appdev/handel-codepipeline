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
const iamCalls = require('../../aws/iam-calls');
const codeBuildCalls = require('../../aws/codebuild-calls');
const util = require('../../common/util');
const winston = require('winston');

function getDeployProjectName(phaseContext) {
    return `${phaseContext.appName}-${phaseContext.pipelineName}-${phaseContext.phaseName}`
}

function createDeployPhaseServiceRole(accountId) {
    let roleName = 'HandelCodePipelineDeployPhaseServiceRole'
    return iamCalls.createRoleIfNotExists(roleName, ['codebuild.amazonaws.com'])
        .then(role => {
            let policyArn = `arn:aws:iam::${accountId}:policy/handel-codepipeline/${roleName}`;
            let policyDocument = util.loadJsonFile(`${__dirname}/deploy-phase-service-policy.json`);
            return iamCalls.createPolicyIfNotExists(roleName, policyArn, policyDocument);
        })
        .then(policy => {
            return iamCalls.attachPolicyToRole(policy.Arn, roleName);
        })
        .then(policyAttachment => {
            return iamCalls.getRole(roleName);
        });
}

function createDeployPhaseCodeBuildProject(phaseContext, accountConfig) {
    let {appName, pipelineName, phaseName} = phaseContext;
    let deployProjectName = getDeployProjectName(phaseContext)
    return createDeployPhaseServiceRole(phaseContext.accountConfig.account_id)
        .then(deployPhaseRole => {
            let handelDeployEnvVars = {
                ENVS_TO_DEPLOY: phaseContext.params.environments_to_deploy.join(","),
                HANDEL_ACCOUNT_CONFIG: new Buffer(JSON.stringify(accountConfig)).toString("base64")
            }
            let handelDeployImage = "aws/codebuild/nodejs:7.0.0";
            let handelDeployBuildSpec = util.loadFile(`${__dirname}/deploy-buildspec.yml`);

            return codeBuildCalls.getProject(deployProjectName)
                .then(buildProject => {
                    if (!buildProject) {
                        winston.info(`Creating Handel deploy phase CodeBuild project ${deployProjectName}`);
                        return codeBuildCalls.createProject(deployProjectName, appName, pipelineName, phaseName, handelDeployImage, handelDeployEnvVars, phaseContext.accountConfig.account_id, deployPhaseRole.Arn, phaseContext.accountConfig.region, handelDeployBuildSpec);
                    }
                    else {
                        winston.info(`Updating Handel deploy phase CodeBuild project ${deployProjectName}`);
                        return codeBuildCalls.updateProject(deployProjectName, appName, pipelineName, phaseName, handelDeployImage, handelDeployEnvVars, phaseContext.accountConfig.account_id, deployPhaseRole.Arn, phaseContext.accountConfig.region, handelDeployBuildSpec)
                    }
                });
        });
}

function getCodePipelinePhaseSpec(phaseContext) {
    return {
        name: phaseContext.phaseName,
        actions: [
            {
                inputArtifacts: [
                    {
                        name: `Output_Build`
                    }
                ],
                name: phaseContext.phaseName,
                actionTypeId: {
                    category: "Test",
                    owner: "AWS",
                    version: "1",
                    provider: "CodeBuild"
                },
                configuration: {
                    ProjectName: getDeployProjectName(phaseContext)
                },
                runOrder: 1
            }
        ]
    }
}

exports.check = function (phaseConfig) {
    let errors = [];

    if (!phaseConfig.environments_to_deploy) {
        errors.push(`GitHub - The 'environments_to_deploy' parameter is required`);
    }

    return errors;
}

exports.getSecretsForPhase = function () {
    return Promise.resolve({});
}

exports.deployPhase = function (phaseContext, accountConfig) {
    return createDeployPhaseCodeBuildProject(phaseContext, accountConfig)
        .then(codeBuildProject => {
            return getCodePipelinePhaseSpec(phaseContext);
        });
}

exports.deletePhase = function (phaseContext, accountConfig) {
    let codeBuildProjectName = getDeployProjectName(phaseContext);
    winston.info(`Delete CodeBuild project for '${codeBuildProjectName}'`);
    return codeBuildCalls.deleteProject(codeBuildProjectName);
}