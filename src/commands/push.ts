import * as fs from 'node:fs';
import pLimit from 'p-limit';
import * as path from 'node:path';
import { ApiError } from '@google-cloud/common';
import {
  BigQuery,
  Dataset,
  // GetDatasetsOptions,
  GetJobsOptions,
  Job,
  // Model,
  Query,
  Routine,
  Table,
} from '@google-cloud/bigquery';

import { DefaultReporter } from '../../src/reporter/index.js';
import { Task } from '../../src/task.js';
import { syncMetadata } from '../../src/metadata.js';
import {
  extractDestinations,
  extractRefenrences,
  humanFileSize,
  msToTime,
  topologicalSort,
} from '../../src/util.js';

import {
  // BigQueryResource,
  // bq2path,
  // buildThrottledBigQueryClient,
  normalizedBQPath,
  path2bq,
} from '../../src/bigquery.js';

type BigQueryJobResource = {
  file: string;
  namespace: string;
  dependencies: string[];
  destinations: string[];
};

const deployBigQueryResouce = async (
  bqClient: BigQuery,
  rootPath: string,
  p: string,
  BigQueryJobOptions?: Query,
) => {
  const msgWithPath = (msg: string) => `${path.dirname(p)}: ${msg}`;
  const defaultProjectId = await bqClient.getProjectId();

  if (p && !p.endsWith('sql')) return undefined;

  const [_, schemaId, name] = path2bq(p, rootPath, defaultProjectId).split('.');
  const query = await fs.promises.readFile(p)
    .then((s: any) => s.toString())
    .catch((err: any) => {
      throw new Error(msgWithPath(err));
    });

  if (!schemaId) {
    throw new Error('Invalid SchemaId');
  }

  const fetchBQJobResource = async (
    job: Job,
  ): Promise<Dataset | Routine | Table | undefined> => {
    await job.promise()
      .catch((e) => e);
    await job.getMetadata();
    if (job.metadata.status.errorResult) {
      throw new Error(job.metadata.status.errorResult.message);
    }

    if (!job.id) {
      throw new Error('Invalid SchemaId');
    }

    const schema = bqClient.dataset(schemaId);
    switch (job.metadata.statistics.query.statementType) {
      case 'SCRIPT':
        const [childJobs] = await bqClient.getJobs(
          { parentJobId: job.id } as GetJobsOptions,
        );
        for (const ix in childJobs) {
          const stat = childJobs[ix]?.metadata.statistics;
          try {
            if (stat.query?.ddlTargetRoutine) {
              const [routine] = await schema.routine(
                stat.query.ddlTargetRoutine.routineId,
              ).get();
              return routine;
            }
            if (stat.query?.ddlTargetTable) {
              const [table] = await schema.table(
                stat.query.ddlTargetTable.tableId,
              ).get();
              return table;
            }
          } catch (e: unknown) {
            // ignore error: Not Found Table or Routine
            if (e instanceof ApiError) {
              if (e.code === 404) {
                continue;
              }
              throw new Error(e.message);
            }
          }
        }
        return undefined;
      case 'CREATE_SCHEMA':
      case 'DROP_SCHEMA':
      case 'ALTER_SCHEMA':
        const [dataset] = await schema.get();
        return dataset;
      case 'CREATE_ROW_ACCESS_POLICY':
      case 'DROP_ROW_ACCESS_POLICY':
        //TODO: row access policy
        throw new Error(
          `Not Supported: ROW_ACCES_POLICY ${job.metadata.statistics}`,
        );
      case 'CREATE_MODEL':
      case 'EXPORT_MODEL':
        //TODO: models
        throw new Error(
          `Not Supported: MODEL ${job.metadata.statistics}`,
        );
      case 'CREATE_FUNCTION':
      case 'CREATE_TABLE_FUNCTION':
      case 'DROP_FUNCTION':
      case 'CREATE_PROCEDURE':
      case 'DROP_PROCEDURE':
        const routineId = name;
        if (!routineId) {
          throw new Error('Invalid routineId');
        }
        const [routine] = await schema.routine(routineId).get();
        return routine;
      case 'CREATE_TABLE':
      case 'CREATE_VIEW':
      case 'CREATE_TABLE_AS_SELECT':
      case 'DROP_TABLE':
      case 'DROP_VIEW':
      case 'ALTER_TABLE':
      case 'ALTER_VIEW':
      case 'INSERT':
      case 'UPDATE':
      case 'DELETE':
      case 'MERGE':
      case 'CREATE_MATERIALIZED_VIEW':
      case 'DROP_MATERIALIZED_VIEW':
        if (!name) {
          throw new Error('Invalid tableId');
        }
        const [table] = await schema.table(name).get();
        return table;

      default:
        throw new Error(
          `Not Supported: ${
            JSON.stringify(job.metadata.statistics)
          } (${job.id} )`,
        );
    }
  };

  switch (path.basename(p)) {
    case 'view.sql':
      const schema = bqClient.dataset(schemaId);
      const tableId = name;
      if (!tableId) {
        return;
      }
      if (BigQueryJobOptions?.dryRun) {
        const [_, ret] = await bqClient.createQueryJob({
          ...BigQueryJobOptions,
          query:
            `CREATE OR REPLACE VIEW \`${schema.id}.${tableId}\` as\n${query}`,
          priority: 'BATCH',
          jobPrefix: `bqport-${schemaId}_${name}-`,
          labels: {
            ...BigQueryJobOptions?.labels,
            'bqport': 'true',
          },
        });

        if (ret.statistics?.totalBytesProcessed !== undefined) {
          return humanFileSize(parseInt(ret.statistics.totalBytesProcessed));
        }
      }

      const api = schema.table(tableId);
      const [isExist] = await api.exists();

      const [view] = await (
        isExist ? api.get() : schema.createTable(tableId, {
          view: query,
        })
      );
      await syncMetadata(view, path.dirname(p), { push: true });
      break;
    default:
      // https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#jobconfiguration
      const [job, ijob] = await bqClient.createQueryJob({
        ...BigQueryJobOptions,
        query,
        priority: 'BATCH',
        jobPrefix: `bqport-${schemaId}_${name}-`,
        labels: {
          ...BigQueryJobOptions?.labels,
          'bqport': 'true',
        },
      });

      if (
        ijob.configuration?.dryRun &&
        ijob.statistics?.totalBytesProcessed !== undefined
      ) {
        return humanFileSize(parseInt(ijob.statistics.totalBytesProcessed));
      }

      try {
        const resource = await fetchBQJobResource(job);
        if (resource !== undefined && resource.id == path.dirname(p)) {
          await syncMetadata(resource, path.dirname(p), { push: true });
        }
      } catch (e: unknown) {
        console.warn((e as Error).message);
      }

      if (job.metadata.statistics?.totalBytesProcessed !== undefined) {
        const stats = job.metadata?.statistics;
        const elpasedTime =
          stats.endTime !== undefined && stats.startTime !== undefined
            ? msToTime(parseInt(stats.endTime) - parseInt(stats.startTime))
            : undefined;

        const totalBytes = humanFileSize(
          parseInt(job.metadata.statistics?.totalBytesProcessed),
        );

        return [totalBytes, elpasedTime].filter((s) => s !== undefined).join(
          ', ',
        );
      }
      break;
  }
  return;
};

const extractBigQueryDependencies = async (
  rootPath: string,
  fpath: string,
  bqClient: BigQuery,
) => {
  const defaultProjectId = await bqClient.getProjectId();
  const [projectID, schema, resource] = path2bq(
    fpath,
    rootPath,
    defaultProjectId,
  ).split('.');
  const sql: string = await fs.promises.readFile(fpath)
    .then((s: any) => s.toString());

  const refs = [
    ...new Set(
      extractRefenrences(sql)
        .map((ref) => normalizedBQPath(ref, projectID)),
    ),
  ];
  const refs_schemas = [...new Set(refs)].map((n) => n.replace(/\.[^.]+$/, ''));

  // Add schema as explict dependencies without self
  const additionals =
    ((schema !== undefined && resource !== undefined)
      ? [normalizedBQPath(schema, projectID, true)]
      : []);
  return [...new Set(refs_schemas.concat(refs).concat(additionals))];
};

const extractBigQueryDestinations = async (
  rootPath: string,
  fpath: string,
  bqClient: BigQuery,
) => {
  const defaultProjectId = await bqClient.getProjectId();
  const bqID = path2bq(fpath, rootPath, defaultProjectId);
  const [projectID] = bqID.split('.');

  if (fpath.endsWith('view.sql')) {
    return [bqID];
  }

  const sql: string = await fs.promises.readFile(fpath)
    .then((s: any) => s.toString());
  const refs = [
    ...new Set(
      extractDestinations(sql)
        .map(([ref, type]) =>
          normalizedBQPath(ref, projectID, type == 'SCHEMA')
        ),
    ),
  ];

  return refs;
};

export async function pushBigQueryResourecs(
  rootPath: string,
  files: string[],
  concurrency: number,
  jobOption: Query,
) {
  const limit = pLimit(concurrency);
  const bqClient = new BigQuery();
  const defaultProjectId = await bqClient.getProjectId();

  const results = await Promise.all(
    files
      .map(async (n: string) => ({
        file: n,
        namespace: path2bq(n, rootPath, defaultProjectId),
        dependencies: (await extractBigQueryDependencies(rootPath, n, bqClient))
          .filter((n) => n !== path2bq(n, rootPath, defaultProjectId)),
        destinations: await extractBigQueryDestinations(rootPath, n, bqClient),
      } as BigQueryJobResource)),
  );

  const relations = [
    ...results
      .reduce(
        (ret, { namespace: ns, dependencies: _deps, destinations: _dsts }) => {
          ret.add(JSON.stringify([ns, '#sentinal']));

          const dsts = new Set<string>(_dsts);
          _dsts
            .forEach(
              (dst: string) => {
                ret.add(JSON.stringify([dst, '#sentinal']));
                _deps
                  //  Intra-file dependencies will ignore
                  .filter((s) => !dsts.has(s))
                  .forEach(
                    (src: string) => {
                      ret.add(JSON.stringify([dst, src]));
                    },
                  );
              },
            );
          return ret;
        },
        new Set(),
      ),
  ]
    .map((n) => (typeof n === 'string') ? JSON.parse(n) : {})
    .filter(([src, dst]) => src !== dst);

  const bigquery2Objs = results.reduce(
    (ret, obj) => {
      ret.set(
        obj.namespace,
        //FIXME: Sort by sql kind (DDL > DML > QUERY)
        [...ret.get(obj.namespace) ?? [], obj],
      );
      return ret;
    },
    new Map<string, BigQueryJobResource[]>(),
  );

  const DAG: Map<string, {
    tasks: Task[];
    // bigquery: BigQueryJobResource;
  }> = new Map(
    topologicalSort(relations)
      .map((bq: string) =>
        [bq, bigquery2Objs.get(bq) ?? []] as [string, BigQueryJobResource[]]
      )
      .filter(([_, tasks]) => (tasks.length ?? 0) > 0)
      .map(
        ([ns, jobs]) => [
          ns,
          {
            // bigquery: ns,
            tasks: jobs.map(
              (job: BigQueryJobResource, ix) =>
                new Task(
                  path.relative(rootPath, job.file).replace(
                    /@default/,
                    defaultProjectId,
                  ),
                  async () => {
                    await Promise.all(
                      job.dependencies
                        .map(
                          (d: string) =>
                            DAG.get(d)?.tasks.map((t) => t.runningPromise),
                        )
                        .flat()
                        .concat(
                          // Intra-directory tasks
                          DAG.get(ns)?.tasks.slice(0, ix).map((t) =>
                            t.runningPromise
                          ) ?? [],
                        ),
                    ).catch(() => {
                      const msg = job.dependencies
                        .map((t) => DAG.get(t)?.tasks)
                        .flat()
                        .filter((t) => t && t.status == 'failed')
                        .map((t) => t?.name).join(', ');
                      throw Error('Suspended: Parent job is faild: ' + msg);
                    });
                    return await deployBigQueryResouce(
                      bqClient,
                      rootPath,
                      job.file,
                      jobOption,
                    );
                  },
                ),
            ),
          },
        ],
      ),
  );

  // Validation: All files should included
  const namespaces = new Set(DAG.keys());
  for (const [key, item] of bigquery2Objs.entries()) {
    if (!namespaces.has(key)) {
      console.warn(`Warning: No deployment files for ${key}`);
    }
    const allDestinations = new Set(item.map((f) => f.destinations).flat());
    if (!allDestinations.has(key) && namespaces.has(key)) {
      console.warn(
        `Warning: No DDL file exist but target directory found: ${key}`,
      );
    }
  }

  const tasks = [...DAG.values()]
    .map(({ tasks }) => {
      tasks.forEach((task) => limit(async () => await task.run()));
      return tasks;
    }).flat();

  const reporter = new DefaultReporter();
  reporter.onInit(tasks);
  while (tasks.some((t) => !t.done())) {
    reporter.onUpdate();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  reporter.onUpdate();

  reporter.onFinished();
}
