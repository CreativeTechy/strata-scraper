// Every locales/<lang>/<namespace>.json file is bundled at build time, so
// translations work offline and a new namespace needs no registration here.
const modules = import.meta.glob('./locales/*/*.json', { eager: true, import: 'default' });

export const resources = {};
for (const [path, messages] of Object.entries(modules)) {
  const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!match) continue;
  const [, language, namespace] = match;
  resources[language] ??= {};
  resources[language][namespace] = messages;
}

export const namespaces = Object.keys(resources.en || {});
