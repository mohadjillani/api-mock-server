#!/usr/bin/env node
import { Command } from 'commander';
import { loadSpec, SpecError } from './spec/load.ts';
import { buildRouteTable } from './spec/route-table.ts';
import { mount } from './server/mount.ts';
import { BUILT_IN, loadScenario, ScenarioError } from './scenarios/load.ts';

const program = new Command();

program
  .name('apimock')
  .description('Run an OpenAPI 3 spec as a mock server with seeded data and chaos scenarios')
  .version('0.1.0');

program
  .command('serve')
  .argument('<spec>', 'path or URL to an OpenAPI 3 document')
  .option('-p, --port <port>', 'port to listen on', '4010')
  .option('-s, --seed <seed>', 'seed for generated data and chaos', '42')
  .option('-c, --scenario <name>', 'built-in name or path to a scenario file', 'happy')
  .option('--strict', 'refuse to send a response its own schema rejects', false)
  .option('--quiet', 'only log errors', false)
  .action(async (spec: string, options: Record<string, string | boolean>) => {
    const document = await loadSpec(spec);
    const scenario = await loadScenario(String(options.scenario));
    const seed = Number(options.seed);
    const quiet = Boolean(options.quiet);

    const { app, store, routes, warnings } = mount({
      document,
      seed,
      scenario,
      strictResponses: Boolean(options.strict),
      onInjected: (event) => {
        if (!quiet) {
          const substituted = event.substitutedFor
            ? ` (scenario asked for ${String(event.substitutedFor)}, which this route does not declare)`
            : '';
          console.log(
            `  chaos: ${event.kind}${event.status ? ` ${String(event.status)}` : ''}${event.delayMs ? ` +${String(event.delayMs)}ms` : ''}${substituted}`,
          );
        }
      },
    });

    const port = Number(options.port);
    const server = app.listen(port, () => {
      console.log(
        `${document.info.title} ${document.info.version} → http://127.0.0.1:${String(port)}`,
      );
      console.log(
        `  ${String(routes.length)} routes, scenario "${scenario.name}", seed ${String(seed)}`,
      );
      for (const collection of store.names()) {
        console.log(`  /${collection}: ${String(store.size(collection))} seeded`);
      }
      for (const warning of warnings) console.warn(`  warning: ${warning}`);
    });

    // A port already in use is the single most common way this fails, and
    // Node's default message does not say which port or suggest the fix.
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`port ${String(port)} is already in use — pass --port to choose another`);
        process.exit(1);
      }
      throw error;
    });
  });

program
  .command('validate')
  .description('Check a spec loads, and report what the mock would serve from it')
  .argument('<spec>', 'path or URL to an OpenAPI 3 document')
  .action(async (spec: string) => {
    const document = await loadSpec(spec);
    const routes = buildRouteTable(document);
    const collections = new Set(routes.map((route) => route.collection).filter(Boolean));

    console.log(
      `${document.info.title} ${document.info.version}: valid OpenAPI ${document.openapi}`,
    );
    console.log(`  ${String(routes.length)} operations`);
    console.log(
      `  ${String(collections.size)} collections: ${[...collections].join(', ') || 'none'}`,
    );

    // The useful half of validation: which routes get real CRUD and which get
    // a generated response with no state behind them.
    const stateless = routes.filter((route) => !route.collection);
    if (stateless.length > 0) {
      console.log(
        `  ${String(stateless.length)} operations are not resource-shaped and will be generated per request:`,
      );
      for (const route of stateless) {
        console.log(`    ${route.method.toUpperCase()} ${route.template}`);
      }
    }

    const unschematised = routes.filter((route) =>
      route.responses.every((response) => !response.schema),
    );
    if (unschematised.length > 0) {
      console.log(
        `  ${String(unschematised.length)} operations declare no response schema and will return {}:`,
      );
      for (const route of unschematised) {
        console.log(`    ${route.method.toUpperCase()} ${route.template}`);
      }
    }
  });

program
  .command('scenarios')
  .description('List the built-in scenarios')
  .action(() => {
    for (const scenario of Object.values(BUILT_IN)) {
      console.log(`${scenario.name.padEnd(10)} ${scenario.description ?? ''}`);
      if (scenario.latency) {
        console.log(
          `           latency ${String(scenario.latency.minMs)}–${String(scenario.latency.maxMs)}ms`,
        );
      }
      for (const injection of scenario.errors ?? []) {
        console.log(
          `           ${String(Math.round(injection.rate * 100))}% → ${String(injection.status)}`,
        );
      }
      if (scenario.rateLimit) {
        console.log(
          `           rate limit ${String(scenario.rateLimit.requests)} per ${String(scenario.rateLimit.windowMs / 1000)}s`,
        );
      }
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof SpecError || error instanceof ScenarioError) {
    // These carry a path or a field name, which is the whole reason they are
    // distinct error types: a stack trace helps nobody whose YAML is wrong.
    console.error(`${error.name}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
