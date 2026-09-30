import config from '../brand.json' with { type: 'json' };

export const brand = {
  ...config,
  displayName: config.name.charAt(0).toUpperCase() + config.name.slice(1),
  repository: `https://github.com/${config.githubOwner}/${config.name}`,
};
