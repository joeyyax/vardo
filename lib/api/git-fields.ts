import { z } from "zod";
import { isSafeBranch, isSafeGitUrl } from "@/lib/docker/validate";

export const gitUrlSchema = z.string().refine(isSafeGitUrl, { message: "Only HTTPS git URLs are allowed" });

export const gitBranchSchema = z.string().refine(isSafeBranch, { message: "Invalid branch name" });

/** Update forms send an empty string to clear the field. */
export const gitUrlUpdateSchema = z.union([gitUrlSchema, z.literal("")]);
export const gitBranchUpdateSchema = z.union([gitBranchSchema, z.literal("")]);
