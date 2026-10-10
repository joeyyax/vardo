-- admin_access becomes the opt-in instance-admin scope. 0069 set it on every admin's token, so clear it.
UPDATE "api_token" SET "admin_access" = false;
