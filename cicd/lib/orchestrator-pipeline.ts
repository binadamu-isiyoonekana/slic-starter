import { Role, ServicePrincipal, PolicyStatement } from '@aws-cdk/aws-iam'
import { Pipeline, PipelineProps, Artifact } from '@aws-cdk/aws-codepipeline'
import { Construct } from '@aws-cdk/cdk'
import { Bucket } from '@aws-cdk/aws-s3'
import {
  S3SourceAction,
  CodeBuildAction,
  ManualApprovalAction
} from '@aws-cdk/aws-codepipeline-actions'
import StageName from './stage-name'
import { OrchestratorDeployProject } from './projects/orchestrator-deploy-project'
import { IntegrationTestProject } from './projects/integration-test-project'
import { E2ETestProject } from './projects/e2e-test-project'

import { SLIC_PIPELINE_SOURCE_ARTIFACT } from './projects/source-project'

export interface OrchestratorPipelineProps extends PipelineProps {
  artifactsBucket: Bucket
}

export class OrchestratorPipeline extends Pipeline {
  constructor(scope: Construct, id: string, props: OrchestratorPipelineProps) {
    const { artifactsBucket, ...rest } = props
    super(scope, id, {
      pipelineName: 'OrchestratorPipeline',
      artifactBucket: artifactsBucket,
      ...rest
    })

    // This role is for managing module pipelines
    const orchestratorCodeBuildRole = new Role(
      this,
      'orchestrator-codebuild-role',
      {
        roleName: 'orchestrator-codebuild-role',
        assumedBy: new ServicePrincipal('codebuild.amazonaws.com')
      }
    )
    orchestratorCodeBuildRole.addToPolicy(
      new PolicyStatement()
        .addActions('codepipeline:GetPipelineExecution')
        .addActions('codepipeline:StartPipelineExecution')
        .addAllResources()
    )

    const sourceOutputArtifact = new Artifact()

    const sourceAction = new S3SourceAction({
      bucket: artifactsBucket,
      bucketKey: SLIC_PIPELINE_SOURCE_ARTIFACT,
      output: sourceOutputArtifact,
      pollForSourceChanges: true,
      actionName: 'SLICSource'
    })

    this.addStage({
      name: 'Source',
      actions: [sourceAction]
    })

    this.addDeployStage(StageName.stg, orchestratorCodeBuildRole, sourceOutputArtifact)

    this.addTestStage(sourceOutputArtifact)

    this.addStage({
      name: 'Approval',
      actions: [new ManualApprovalAction({
        actionName: 'MoveToProduction'
      })]
    })

    this.addDeployStage(StageName.prod, orchestratorCodeBuildRole, sourceOutputArtifact)
  }

  addTestStage(sourceOutputArtifact: Artifact) {
    const integrationTestProject = new IntegrationTestProject(
      this,
      `IntegrationTests`,
      {
        stageName: StageName.stg
      }
    )

    const integrationTestOutputArtifact = new Artifact()
    const integrationTestAction = new CodeBuildAction({
      actionName: 'integration_tests',
      input: sourceOutputArtifact,
      output: integrationTestOutputArtifact,
      project: integrationTestProject
    })

    const e2eTestProject = new E2ETestProject(
      this,
      `e2eTests`,
      {
        stageName: StageName.stg
      }
    )

    const e2eTestOutputArtifact = new Artifact()
    const e2eTestAction = new CodeBuildAction({
      actionName: 'e2e_tests',
      input: sourceOutputArtifact,
      output: e2eTestOutputArtifact,
      project: e2eTestProject
    })

    this.addStage({
      name: `Test`,
      actions:[integrationTestAction, e2eTestAction]
    })
  }

  addDeployStage(stageName: StageName, orchestratorCodeBuildRole: Role, sourceOutputArtifact: Artifact) {
    const orchestratorDeployStagingProject = new OrchestratorDeployProject(
      this,
      `${stageName}OrchestratorDeploy`,
      {
        stageName,
        role: orchestratorCodeBuildRole
      }
    )

    const deployOutputArtifact = new Artifact()
    const deployAction = new CodeBuildAction({
      actionName: stageName,
      input: sourceOutputArtifact,
      output: deployOutputArtifact,
      project: orchestratorDeployStagingProject
    })

    this.addStage({
      name: `${stageName}Deploy`,
      actions: [deployAction]
    })
  }
}
