# Migration Checklist

**Client:** {ClientName}  
**Project:** {ProjectName}

This checklist helps guide the transition of your application away from Provider-managed hosting.

You can complete this checklist on your own or request paid migration assistance.

---

## 1. Planning

☐ Decide where the application will be hosted next  
☐ Confirm who will manage the new hosting environment  
☐ Review timelines and any upcoming deadlines  

---

## 2. Access & Accounts

☐ Ensure you have access to all third-party services (domains, email, storage, APIs)  
☐ Confirm ownership of cloud storage accounts (e.g., S3, R2)  
☐ Verify credentials for services required by the application  

---

## 3. Data Export

☐ Use the **Request Application Data** feature to generate an export  
☐ Download and securely store the export  
☐ Confirm the export includes:
- Application source code
- Database backup
- Uploaded media and files  

---

## 4. New Environment Preparation

☐ Set up the new hosting environment  
☐ Configure required runtime versions and dependencies  
☐ Provision databases and storage  
☐ Apply environment variables and secrets  

---

## 5. Deployment

☐ Deploy application code from the exported source  
☐ Restore database data  
☐ Connect media storage  
☐ Verify application functionality  

---

## 6. Validation

☐ Test core features and workflows  
☐ Confirm content and media load correctly  
☐ Review logs for errors  
☐ Validate user access and permissions  

---

## 7. Cutover (If Applicable)

☐ Choose a cutover date and time  
☐ Update DNS or routing as needed  
☐ Monitor the application after cutover  

---

## 8. Decommissioning

☐ Confirm all data has been exported  
☐ Notify Provider when hosting can be shut down  
☐ Archive exports for your records  

---

## Notes

- Migration complexity varies by project
- Provider does not guarantee compatibility with new environments
- Migration assistance is available if needed

If you have questions at any stage, just ask.