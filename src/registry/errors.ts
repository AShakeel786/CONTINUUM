export class ProjectNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`No project matches "${key}". Run "continuum project list" to see registered projects.`);
    this.name = "ProjectNotFoundError";
    this.key = key;
  }
}

export class ProjectAlreadyExistsError extends Error {
  readonly nameOrId: string;
  constructor(nameOrId: string, detail: string) {
    super(`Cannot add project: ${detail}`);
    this.name = "ProjectAlreadyExistsError";
    this.nameOrId = nameOrId;
  }
}

export class ProjectConflictError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ProjectConflictError";
  }
}
