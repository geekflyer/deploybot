import { Application, Context, Octokit, Logger } from "probot";
import { render } from "../util";
import yaml from "js-yaml";
import { validate } from "jsonschema";
import {
  ReposListDeploymentsResponseItem,
  PullsGetResponse,
  ReposGetContentsParams
} from "@octokit/rest";
import schema from "../schema.json";
import { canWrite } from "./auth";
import { LockStore } from "../store";

const previewAnt = "application/vnd.github.ant-man-preview+json";
const previewFlash = "application/vnd.github.flash-preview+json";

function withPreview<T>(arg: T): T {
  (arg as any).headers = { accept: `${previewAnt},${previewFlash}` };
  return arg as T;
}

function logCtx(context: Context, params: any) {
  return {
    context: {
      installation: context.payload.installation,
      repo: context.payload.repository ? context.repo() : undefined
    },
    ...params
  };
}

interface DeployBody {
  auto_merge: boolean;
  task: string;
  payload: any;
  environment: string;
  description: string;
  transient_environment: boolean;
  production_environment: boolean;
  required_contexts: string[];
}

export interface Target {
  name: string;
  auto_deploy_on: string;
  auto_merge: boolean;
  task: string;
  payload: any;
  environment: string;
  description: string;

  // Required contexts  are required to be matched across all deployments in the
  // target set. This is so that one deployment does not succeed before another
  // causing the set to fail.
  required_contexts: string[];

  // Environment information must be copied into all deployments.
  transient_environment: boolean;
  production_environment: boolean;
}

export type Targets = { [k: string]: Target | undefined };

export async function config(
  github: Octokit,
  {
    owner,
    repo,
    ref
  }: {
    owner: string;
    repo: string;
    ref?: string;
  }
): Promise<Targets> {
  const params: ReposGetContentsParams = {
    owner,
    repo,
    path: `.github/deploy.yml`
  };
  if (ref) params.ref = ref;
  const content = await github.repos.getContents(params);
  const conf =
    yaml.safeLoad(Buffer.from(content.data.content, "base64").toString()) || {};

  const fields = [
    "task",
    "auto_merge",
    "payload",
    "environment",
    "description"
  ];
  for (const key in conf) {
    if (conf[key].deployments && conf[key].deployments.length > 0) {
      const dep = conf[key].deployments[0];
      const tar = conf[key];
      fields.forEach(field => {
        tar[field] = tar[field] || dep[field];
      });
      delete conf[key].deployments;
    }
  }

  const validation = validate(conf, schema, {
    propertyName: "config",
    allowUnknownAttributes: true
  });
  if (validation.errors.length > 0) {
    const err = validation.errors[0];
    throw new Error(`${err.property} ${err.message}`);
  }
  for (const key in conf) {
    conf[key].name = key;
  }
  return conf;
}

function getDeployBody(target: Target, data: any): DeployBody {
  return withPreview({
    task: target.task || "deploy",
    transient_environment: target.transient_environment || false,
    production_environment: target.production_environment || false,
    environment: render(target.environment || "production", data),
    auto_merge: target.auto_merge || false,
    required_contexts: target.required_contexts || [],
    description: render(target.description, data),
    payload: {
      target: target.name,
      ...render(target.payload, data)
    }
  });
}

async function handlePRDeploy(context: Context, command: string) {
  context.log.info(logCtx(context, { command }), "pr deploy: handling command");
  try {
    const target = command.split(" ")[1];
    const pr = await context.github.pulls.get({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      pull_number: context.payload.issue.number
    });

    const write = await canWrite(
      context.github,
      context.repo({ username: context.payload.comment.user.login })
    );
    if (!write) {
      context.log.info(logCtx(context, {}), "pr deploy: no write priviledges");
      return;
    }

    await deployCommit(
      context.github,
      context.log,
      context.repo({
        target,
        ref: pr.data.head.ref,
        sha: pr.data.head.sha,
        pr: pr.data
      })
    );
  } catch (error) {
    await context.github.issues.createComment({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      body: `:rotating_light: Failed to trigger deployment. :rotating_light:\n${error.message}`
    });
  }
}

/**
 * Deploy commit handles all the necessities of creating a conformant deployment
 * including templating and more. All deploys should go through this function.
 * We need to deploy always using the ref of a branch so that finding
 * deployments later we can query using the branch ref.
 */
export async function deployCommit(
  github: Octokit,
  log: Logger,
  {
    owner,
    repo,
    target,
    ref,
    sha,
    pr
  }: {
    owner: string;
    repo: string;
    target: string;
    ref: string;
    sha: string;
    pr?: PullsGetResponse;
  }
) {
  const logCtx = {
    deploy: { target, ref, pr },
    context: { repo: { owner, repo } }
  };
  const commit = await github.git.getCommit({ owner, repo, commit_sha: sha });

  // Params are the payload that goes into every deployment - change these in a
  // backwards compatible way always.
  const params = {
    ref,
    target,
    owner,
    repo,
    short_sha: sha.substr(0, 7),
    commit: commit.data,
    pr: pr ? pr.number : undefined,
    pull_request: pr
  };

  const conf = await config(github, { owner, repo, ref });
  const targetVal = conf[target];
  if (!targetVal) {
    log.info(logCtx, "deploy: failed - no target");
    throw new Error(`Deployment target "${target}" does not exist`);
  }

  const body = {
    owner,
    repo,
    ref,
    ...getDeployBody(targetVal, params)
  };
  try {
    log.info({ ...logCtx, body }, "deploy: deploying");
    // TODO: Handle auto_merge case correctly here.
    // https://developer.github.com/v3/repos/deployments/#merged-branch-response
    const deploy = await github.repos.createDeployment(body);
    log.info({ ...logCtx, body }, "deploy: successful");
    return deploy.data;
  } catch (error) {
    if (error.status === 409) {
      log.info({ ...logCtx, error, body }, "deploy: checks not ready");
    } else {
      log.error({ ...logCtx, error, body }, "deploy: failed");
    }
    throw error;
  }
}

async function handleAutoDeploy(context: Context, ref: string) {
  context.log.info(
    logCtx(context, { ref }),
    "auto deploy: checking deployments"
  );
  try {
    const conf = await config(context.github, context.repo());
    await Promise.all(Object.keys(conf).map(async key => {
      const deployment = conf[key]!;
      if (deployment.auto_deploy_on !== ref) {
        context.log.info(
          logCtx(context, { ref, target: key }),
          "auto deploy: skipping target"
        );
        return;
      }

      // Will not throw an error here:
      await autoDeployTarget(context, key, deployment);
    }));
  } catch (error) {
    if (error.code === 404) {
      context.log.info(logCtx(context, { error }), "auto deploy: no config");
    } else {
      context.log.error(logCtx(context, { error }), "auto deploy: failed");
    }
  }
}

async function autoDeployTarget(
  context: Context,
  target: string,
  targetVal: Target
) {
  const autoDeploy = targetVal.auto_deploy_on;
  if (!autoDeploy) {
    return;
  }
  const ref = autoDeploy.replace("refs/", "");
  context.log.info(logCtx(context, { ref }), "auto deploy: verifying");
  const refData = await context.github.git.getRef(context.repo({ ref }));
  const sha = refData.data.object.sha;

  const deploys = await context.github.repos.listDeployments(
    context.repo({ sha })
  );
  if (deploys.data.find(d => d.environment === targetVal.environment)) {
    context.log.info(logCtx(context, { ref }), "auto deploy: already deployed");
    return;
  }

  context.log.info(logCtx(context, { ref }), "auto deploy: deploying");
  try {
    await deployCommit(
      context.github,
      context.log,
      context.repo({
        ref,
        sha,
        target
      })
    );
    context.log.info(logCtx(context, { ref }), "auto deploy: done");
  } catch (error) {
    if (error.status === 409) {
      context.log.info(
        logCtx(context, { target, ref, error }),
        "auto deploy: checks not ready"
      );
    } else {
      context.log.error(
        logCtx(context, { target, ref, error }),
        "auto deploy: deploy attempt failed"
      );
    }
  }
}

async function handlePRClose(context: Context) {
  const ref = context.payload.pull_request.head.ref;
  const sha = context.payload.pull_request.head.sha;
  const deployments = await context.github.repos.listDeployments(
    withPreview({ ...context.repo(), ref })
  );
  context.log.info(logCtx(context, { ref }), "pr close: listed deploys");

  // List all deployments for this pull request by environment to undeploy the
  // last deployment for every environment.
  const environments: { [env: string]: ReposListDeploymentsResponseItem } = {};
  for (const deployment of deployments.data.reverse()) {
    // Only terminate transient environments.
    if (!deployment.transient_environment) {
      context.log.info(
        logCtx(context, { ref, deployment: deployment.id }),
        "pr close: not transient"
      );
      continue;
    }
    try {
      context.log.info(
        logCtx(context, { ref, deployment: deployment.id }),
        "pr close: mark inactive"
      );
      await context.github.repos.createDeploymentStatus(
        withPreview({
          ...context.repo(),
          deployment_id: deployment.id,
          state: "inactive"
        })
      );
    } catch (error) {
      context.log.error(
        logCtx(context, { error, ref, deployment: deployment.id }),
        "pr close: marking inactive failed"
      );
    }
    environments[deployment.environment] = deployment;
  }

  context.log.info(
    logCtx(context, {
      ref,
      environments: Object.keys(environments).map(e => e)
    }),
    "pr close: remove deploys"
  );
  for (const env in environments) {
    const deployment = environments[env];
    try {
      context.log.info(
        logCtx(context, { ref, deployment: deployment.id }),
        "pr close: remove deploy"
      );
      // Undeploy for every unique environment by copying the deployment params
      // and triggering a deployment with the task "remove".
      await context.github.repos.createDeployment(
        context.repo({
          ref: sha,
          task: "remove",
          required_contexts: [],
          payload: deployment.payload as any,
          environment: deployment.environment,
          description: deployment.description || "",
          transient_environment: deployment.transient_environment,
          production_environment: deployment.production_environment
        })
      );
    } catch (error) {
      context.log.error(
        logCtx(context, { error, ref, deployment: deployment.id }),
        "pr close: failed to undeploy"
      );
    }
  }
}

export function commands({
  robot: app,
  lockStore
}: {
  robot: Application;
  lockStore: () => LockStore;
}) {
  const locker = lockStore();

  const doAutoDeploy = (context: Context, ref: string) => {
    const key = `${context.payload.repository.id}-${ref.replace(/\//g, "-")}-ad`;
    context.log.info({ key }, "auto deploy: locked")
    return locker.lock(key, () => handleAutoDeploy(context, ref));
  };

  app.on("push", async context => {
    await doAutoDeploy(context, context.payload.ref);
  });
  app.on("status", async context => {
    if (context.payload.state === "success") {
      for (const branch of context.payload.branches) {
        await doAutoDeploy(context, `refs/heads/${branch.name}`);
      }
    }
  });
  app.on("check_run", async context => {
    if (context.payload.check_run.status === "completed") {
      await doAutoDeploy(
        context,
        `refs/heads/${context.payload.check_run.check_suite.head_branch}`
      );
    }
  });
  app.on("issue_comment.created", async context => {
    if (context.payload.comment.body.startsWith("/deploy")) {
      await handlePRDeploy(context, context.payload.comment.body);
    }
  });
  app.on("pull_request.closed", async context => {
    await handlePRClose(context);
  });
}
