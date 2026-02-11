# Hosting Addendum (Managed Application Hosting)

**Client:** {ClientName}  
**Project:** {ProjectName}  
**Related Agreement:** {ContractName}  
**Effective Date:** {EffectiveDate}

This Hosting Addendum supplements the Service Agreement. If there is a conflict, the Service Agreement controls.

---

## 1. Hosting Model

Provider offers **managed application hosting**, not general-purpose hosting or server access.

The hosted environment is fully managed by Provider and deployed using Provider’s infrastructure and tooling.

Client does not receive direct server, SSH, or FTP access.

---

## 2. What Is Hosted

Provider will host and manage the following components:

- Application code deployed from version control  
- Runtime environment and deployment pipeline  
- Database services (if applicable)  
- Media and file storage via Client-owned cloud storage (e.g., Cloudflare R2 or Amazon S3)

Provider may use third-party infrastructure providers to deliver these services.

---

## 3. Access and Control

- Provider maintains full control over the hosting environment.
- Client access is provided through the application itself (admin interfaces, dashboards, etc.).
- Direct infrastructure access (SSH, FTP, root access) is not provided.

This model is intentional and supports security, reliability, and consistent deployments.

---

## 4. Version Control and Deployments

- All application code is maintained in version control.
- Deployments are performed by Provider using a controlled deployment process.
- Changes made outside the agreed workflow are not supported.

---

## 5. Backups

Provider maintains backups of hosted systems as part of normal operations.

Backups are intended for recovery assistance, not as a sole or guaranteed data protection mechanism.

Backup scope, frequency, and retention depend on configuration and third-party services.

---

## 6. Data Ownership and Automated Export

All Client data generated or stored within the hosted application remains the property of Client.

Client may request a copy of this application data at any time using Provider’s automated data export process.

The automated export is designed to provide, in a standard and portable format:
- The application source code as deployed
- A database backup for the hosted application
- Uploaded media and files associated with the application

This export does not include internal Provider systems, administrative records, or client management data.

---

## 7. Client-Provided Infrastructure

Certain components (such as object storage for media) may be provisioned in Client-owned accounts.

Provider may assist with initial setup and configuration, but ownership and billing remain with Client.

---

## 8. Availability and Uptime

Provider does not guarantee uninterrupted availability or specific uptime levels.

Outages may occur due to:
- Third-party infrastructure providers
- Network issues
- Software updates
- Factors outside Provider’s control

Provider will make reasonable efforts to restore service when issues arise.

---

## 9. Security Responsibilities

Provider takes reasonable measures to secure the managed environment.

Client is responsible for:
- Application-level users and permissions
- Content and data entered into the system
- Decisions regarding compliance, data retention, and access policies

No system can be guaranteed fully secure.

---

## 10. Fees

Hosting fees are:
- {HostingFeeDescription}
- Billed: {HostingBillingCadence}

Third-party infrastructure costs may be billed directly to Client or passed through.

---

## 11. Termination and Transition

If hosting services end:
- Client remains responsible for their data and accounts
- Provider will provide data exports as described above
- Provider may assist with migration upon request and at standard rates

---

## 12. Acceptance

☐ I agree to this Hosting Addendum

Name: {ClientSignerName}  
Date: {AcceptanceDate}