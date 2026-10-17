import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { PERMISSION_CATALOGUE, PERMISSION_DEPENDENCIES } from "../../lib/permissions.js";
import {
  addMemberSchema,
  changeMemberRoleSchema,
  copyRoleSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  upsertDocumentTypeSchema,
  upsertRoleSchema,
} from "./department.schemas.js";
import * as departmentService from "./department.service.js";
import { DepartmentError } from "./department.service.js";

function actorFrom(request: FastifyRequest): departmentService.Actor {
  return {
    userId: request.user!.sub,
    organizationId: request.user!.organizationId!,
    isSuperAdmin: request.user!.isSuperAdmin === true,
  };
}

function handleDepartmentError(err: unknown, reply: FastifyReply) {
  if (err instanceof DepartmentError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

export default async function departmentRoutes(app: FastifyInstance, opts: { prisma: PrismaClient }) {
  const deps = { prisma: opts.prisma };
  const inOrg = { preHandler: [app.authenticate, app.requireVerifiedEmail, app.requireOrganization] };
  const superAdminOnly = {
    preHandler: [app.authenticate, app.requireVerifiedEmail, app.requireOrganization, app.requireSuperAdmin],
  };

  // The catalogue the role editor renders. Served from the server so the client can never drift
  // from the key set the server validates against.
  app.get("/permission-catalogue", inOrg, async (_request, reply) =>
    reply.send({ groups: PERMISSION_CATALOGUE, dependencies: PERMISSION_DEPENDENCIES }),
  );

  app.get("/templates", inOrg, async (_request, reply) =>
    reply.send({ templates: departmentService.listTemplates() }),
  );

  app.get("/", inOrg, async (request, reply) => {
    const departments = await departmentService.listDepartments(deps, actorFrom(request));
    return reply.send({ departments });
  });

  app.get("/:departmentId", inOrg, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    try {
      const department = await departmentService.getDepartment(deps, actorFrom(request), departmentId);
      return reply.send({ department });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  // Creating a department is organization-level administration (Feature Spec §2A.1).
  app.post("/", superAdminOnly, async (request, reply) => {
    const body = createDepartmentSchema.parse(request.body);
    try {
      const department = await departmentService.createDepartment(deps, actorFrom(request), body);
      return reply.code(201).send({ department });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  app.patch("/:departmentId", inOrg, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    const body = updateDepartmentSchema.parse(request.body);
    try {
      const department = await departmentService.updateDepartment(deps, actorFrom(request), departmentId, body);
      return reply.send({ department });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  // ── Document types ──
  app.post("/:departmentId/document-types", inOrg, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    const body = upsertDocumentTypeSchema.parse(request.body);
    try {
      const documentType = await departmentService.createDocumentType(deps, actorFrom(request), departmentId, body);
      return reply.code(201).send({ documentType });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  app.put("/:departmentId/document-types/:documentTypeId", inOrg, async (request, reply) => {
    const { departmentId, documentTypeId } = request.params as {
      departmentId: string;
      documentTypeId: string;
    };
    const body = upsertDocumentTypeSchema.parse(request.body);
    try {
      const documentType = await departmentService.updateDocumentType(
        deps,
        actorFrom(request),
        departmentId,
        documentTypeId,
        body,
      );
      return reply.send({ documentType });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  app.delete("/:departmentId/document-types/:documentTypeId", inOrg, async (request, reply) => {
    const { departmentId, documentTypeId } = request.params as {
      departmentId: string;
      documentTypeId: string;
    };
    try {
      const result = await departmentService.deleteDocumentType(
        deps,
        actorFrom(request),
        departmentId,
        documentTypeId,
      );
      return reply.send(result);
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  // ── Roles ──
  app.post("/:departmentId/roles", inOrg, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    const body = upsertRoleSchema.parse(request.body);
    try {
      const role = await departmentService.createRole(deps, actorFrom(request), departmentId, body);
      return reply.code(201).send({ role });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  app.post("/:departmentId/roles/:roleId/copy", inOrg, async (request, reply) => {
    const { departmentId, roleId } = request.params as { departmentId: string; roleId: string };
    const body = copyRoleSchema.parse(request.body);
    try {
      const role = await departmentService.copyRole(deps, actorFrom(request), departmentId, roleId, body.name);
      return reply.code(201).send({ role });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  app.put("/:departmentId/roles/:roleId", inOrg, async (request, reply) => {
    const { departmentId, roleId } = request.params as { departmentId: string; roleId: string };
    const body = upsertRoleSchema.parse(request.body);
    try {
      const role = await departmentService.updateRole(deps, actorFrom(request), departmentId, roleId, body);
      return reply.send({ role });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  app.delete("/:departmentId/roles/:roleId", inOrg, async (request, reply) => {
    const { departmentId, roleId } = request.params as { departmentId: string; roleId: string };
    try {
      const result = await departmentService.deleteRole(deps, actorFrom(request), departmentId, roleId);
      return reply.send(result);
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  // ── Members ──
  // Org users who can be added here (gated by members.invite inside the service, so a Department
  // Admin can use it too; the Super Admin is excluded from the list).
  app.get("/:departmentId/addable-members", inOrg, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    try {
      const members = await departmentService.listAddableMembers(deps, actorFrom(request), departmentId);
      return reply.send({ members });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  app.post("/:departmentId/members", inOrg, async (request, reply) => {
    const { departmentId } = request.params as { departmentId: string };
    const body = addMemberSchema.parse(request.body);
    try {
      const member = await departmentService.addMember(
        deps,
        actorFrom(request),
        departmentId,
        body.userId,
        body.roleId,
      );
      return reply.code(201).send({ member });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  app.patch("/:departmentId/members/:userId", inOrg, async (request, reply) => {
    const { departmentId, userId } = request.params as { departmentId: string; userId: string };
    const body = changeMemberRoleSchema.parse(request.body);
    try {
      const member = await departmentService.changeMemberRole(
        deps,
        actorFrom(request),
        departmentId,
        userId,
        body.roleId,
      );
      return reply.send({ member });
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });

  app.delete("/:departmentId/members/:userId", inOrg, async (request, reply) => {
    const { departmentId, userId } = request.params as { departmentId: string; userId: string };
    try {
      const result = await departmentService.removeMember(deps, actorFrom(request), departmentId, userId);
      return reply.send(result);
    } catch (err) {
      return handleDepartmentError(err, reply);
    }
  });
}
