import {
  EMPTY_SANDBOX_IMAGE_CATALOG,
  resolveSandboxImage,
  type SandboxExecutor,
  type SandboxFactoryContext,
  type SandboxImageCatalog,
} from "@open-managed-agents/sandbox";
import type {
  Environment,
  Session,
} from "@open-managed-agents/managed-agents-application";

type SandboxScope = Pick<SandboxFactoryContext, "environmentId" | "workspaceId" | "image">;

export interface ManagedSandboxBuilderDependencies {
  /** Operator SANDBOX_IMAGES catalog; empty when unset. */
  images?: SandboxImageCatalog;
  /** Per-session host workdir for a session id. */
  workdir(sessionId: string): string;
  /** The foundation's factory call: shared memory/outputs ctx plus scope. */
  build(sessionId: string, workdir: string, scope: SandboxScope): Promise<SandboxExecutor>;
}

/**
 * The managed runner's `buildSandbox`: carries the owning workspace and
 * Environment into SandboxFactoryContext and resolves the Environment's
 * `_oma.sandbox_image` alias against the operator catalog. A selected alias
 * that the catalog no longer publishes fails the sandbox (and so the session
 * start) with SandboxImageUnavailableError; it never falls back to the
 * provider default image.
 */
export function createManagedSandboxBuilder(dependencies: ManagedSandboxBuilderDependencies) {
  const images = dependencies.images ?? EMPTY_SANDBOX_IMAGE_CATALOG;
  return async (input: {
    workspaceId: string;
    session: Pick<Session, "id">;
    environment: Pick<Environment, "id" | "openma">;
  }): Promise<SandboxExecutor> => {
    const image = resolveSandboxImage(
      images,
      input.environment.openma?.sandboxImage,
      input.environment.id,
    );
    return dependencies.build(input.session.id, dependencies.workdir(input.session.id), {
      workspaceId: input.workspaceId,
      environmentId: input.environment.id,
      ...(image !== undefined && { image }),
    });
  };
}
