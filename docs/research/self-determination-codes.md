# Service code systems for self-determination / participant-directed billing

Research for Vexo Field Assistant. Goal: replace the placeholder `DEMO-ILS` code with a real, configurable model of service codes, units, rates, authorizations and required documentation.

- Researched: 2026-11-14
- Primary target: California Self-Determination Program (SDP), run by DDS through regional centers
- Labels used in this doc: **[V]** means verified against the cited source in this session. **[I]** means my inference or recommendation. "Not found" means I looked and could not confirm it.
- Code tables change often. Each source below lists its version or date. Re-check before going live.

---

## 0. Key sources (version / date)

| # | Source | Version / date | URL |
|---|---|---|---|
| S1 | DDS, *SDP Service Codes by Budget Category* | Created 2019-02-18, modified 2019-05-02 (latest code table DDS publishes) | https://www.dds.ca.gov/wp-content/uploads/2019/05/SDP_Service_Codes_02142019.pdf |
| S2 | DDS, *SDP Service Definitions* | Footer dated 2018-06-07 (PDF 2018-07-09) | https://www.dds.ca.gov/wp-content/uploads/2019/05/SDP_serviceDefinitions.pdf |
| S3 | CMS approval + 1915(c) application, SDP waiver **CA.1166.R02.00** | Approved 2026-09-02, effective 2026-07-01 (PDF dated 2026-09-04) | https://www.dds.ca.gov/wp-content/uploads/2026/09/Application_1915cHCBSWaiver_-CA-1166-R02-00_20260701.pdf |
| S4 | DDS directive, *SDP: Billing Requirements for Services* (+ Enclosure A flowchart) | 2023-12-26; compliance for services after 2024-03-31 per the 2024-01-22 clarification | https://www.dds.ca.gov/wp-content/uploads/2023/12/SDP-Billing-Requirements-for-Services.pdf ; https://www.dds.ca.gov/wp-content/uploads/2024/04/Enclosure-A-Billing-Requirements-Flowchart.pdf |
| S5 | DDS directive, *SDP: Updated Billing Requirements for Services Billing at "Other Rate"* | 2024-04-22; services after 2024-06-30 | https://www.dds.ca.gov/wp-content/uploads/2024/04/SDP-Billing-Requirements-for-Other-Rates.pdf |
| S6 | DDS directive D-2026-Self-Determination Program-003, *SDP FMS Vendor Standards* + Attachment A | 2026-10-14 | https://www.dds.ca.gov/wp-content/uploads/2026/10/D-2026-SelfDeterminationProgram-003.pdf ; https://www.dds.ca.gov/wp-content/uploads/2026/10/Attachment-A.pdf |
| S7 | DDS, *Types of FMS for SDP Participants* (model comparison chart) | 2021-04-27 | https://www.dds.ca.gov/wp-content/uploads/2021/04/FMSModelsComparisonChart_04272021.pdf |
| S8 | DDS, *SDP FMS Monthly Rates* | Effective 2023-12-01 | https://www.dds.ca.gov/wp-content/uploads/2023/06/SDP-FMS-Monthly-Rates-2.pdf |
| S9 | DDS, *EVV: Regional Center Service Codes Subject to EVV* | 2022-07-08 | https://www.dds.ca.gov/wp-content/uploads/2022/07/EVV_RC_Service_Codes_Guidance.pdf |
| S10 | DDS, *EVV: Provider Compliance in the SDP* + bill-payer flyer | 2023-08-02 | https://www.dds.ca.gov/wp-content/uploads/2023/08/Electronic-Visit-Verification-Provider-Compliance-in-the-Self-Determination-Program.pdf ; https://www.dds.ca.gov/wp-content/uploads/2023/08/Enclosure-B-Bill-Payer-Services-Flyer.pdf |
| S11 | DDS, *EVV FAQs* | March 2024 | https://www.dds.ca.gov/wp-content/uploads/2024/04/EVV_FAQs_March_2024.pdf |
| S12 | 17 CCR § 54342 (regional center service codes) | Last amendment filed 2019-04-22, operative 2019-07-01 | https://www.law.cornell.edu/regulations/california/17-CCR-54342 |
| S13 | 17 CCR § 50604 (service provider records) | Last amendment 2012 (operative 2012-02-16); CoC 2013-03-11 | https://www.law.cornell.edu/regulations/california/17-CCR-50604 |
| S14 | DDS D-2024-Rate Reform-009 (062/520/635/896) + Attachment B subcodes | 2024-12-04, effective 2025-01-01 | https://www.dds.ca.gov/wp-content/uploads/2024/12/D-2024-RateReform-009_RateReform_ImplementationForPersonalAssistance_IndependentAndSupport.pdf ; https://www.dds.ca.gov/wp-content/uploads/2024/12/D-2024-RateReform-009_AttachmentB_PersonalAssistance_IndependentAndSupportedLiving_Service.pdf |
| S15 | DDS D-2024-Rate Reform-008 REV (adult day services incl. 055/063) | 2025-12-19 | https://www.dds.ca.gov/wp-content/uploads/2026/01/D-2024RateReform-008_REV.pdf |
| S16 | DDS D-2024-Rate Reform-007, Attachment B (employment subcodes 950/952/954) | Latest copy uploaded 2026-07 (REV copy 2024-11) | https://www.dds.ca.gov/wp-content/uploads/2026/07/AttachmentB.pdf |
| S17 | DDS Rate Reform Service Code Crosswalk | Last updated 2026-02-05 | https://www.dds.ca.gov/wp-content/uploads/2026/02/RateReform_ServiceCode_Crosswalk_20260205.pdf |
| S18 | DDS, SDP HCBS settings assessment, Enclosure A (list of RC codes) | 2022-03-17 | https://www.dds.ca.gov/wp-content/uploads/2022/03/DDS_Guidance_SDP_SettingAssessment_EnclosureA_ServiceCodes_03172022.pdf |
| S19 | DDS D-2025-Self Determination Program-003 (budgets, spending plans, AB 143) | 2025-11-25 | https://www.dds.ca.gov/wp-content/uploads/2025/11/D-2025-Self-DeterminationProgram-003.pdf |
| S20 | DDS, General Self-Directed Supports service definition (code 099) | Enclosure dated Dec 2023 | https://www.dds.ca.gov/wp-content/uploads/2023/12/Enclosure-A-Service-Definition-General-SD-Supports.pdf |
| S21 | CMS HCPCS Level II alpha-numeric file | **October 2026** release (file dated 2026-09-23) | https://www.cms.gov/files/zip/october-2026-alpha-numeric-hcpcs-file.zip |
| S22 | Medicaid.gov, EVV guidance page | Accessed 2026-11-14 | https://www.medicaid.gov/medicaid/home-community-based-services/home-community-based-services-guidance-additional-resources/electronic-visit-verification |
| S23 | NY DOH/OPWDD rate code list | "OPWDD Rate Codes as of 5/1/25", page revised July 2026 | https://healthweb-back.health.ny.gov/health_care/medicaid/rates/mental_hygiene/info/rate_code_list.htm |
| S24 | Oregon ODDS, *eXPRS Procedure Code and Modifier Codes* | Updated 2025-10-16 | https://apps.state.or.us/exprsDocs/procedure-modifier-codes.pdf |
| S25 | ACL/VA, *Veteran Directed Care Billing and Invoicing Guide* | October 2024 | https://acl.gov/sites/default/files/No%20Wrong%20Door/vdc-billing-guide-nwd.pdf |
| S26 | 42 CFR 431.107 (provider agreements / records) | Current text (via LII) | https://www.law.cornell.edu/cfr/text/42/431.107 |
| S27 | State rounding examples: Kentucky DMS EVV policy letter; Oklahoma OAC 317:35-17 (ADvantage billing) | KY letter undated in source; OK current policy page | https://chfs.ky.gov/agencies/dms/dca/Documents/evvpolicyupdatesletter.pdf ; https://oklahoma.gov/ohca/policies-and-rules/xpolicy/medical-assistance-for-adults-and-children-eligibility/advantage-waiver-services/billing-procedures-for-advantage-services.html |

---

## 1. California Self-Determination Program (SDP)

### 1.1 Two code systems in California: SDP codes and traditional regional center codes

| Aspect | Traditional regional center (RC) system | SDP |
|---|---|---|
| Code list | 17 CCR § 54342 plus DDS-created codes (3-digit), with **subcodes** since rate reform (2025) [V S12, S14] | DDS "SDP Service Codes by Budget Category", 3-digit codes **310–399** [V S1] |
| Who bills the RC | The vendored provider bills the RC directly | The **FMS** bills the RC. Providers invoice the FMS [V S4, S6 §15] |
| Rate | Department-set rate / rate model per RC, by service code + subcode (staffing ratio) [V S14, S16] | Negotiated between participant and provider. FMS checks it is reasonable and within the spending plan [V S4, S6 §8.3] |
| Federal authority | HCBS-DD waiver and others (not researched here) | 1915(c) waiver CA.1166 (renewed R02.00, effective 2026-07-01) [V S3] |

**Important:** SDP providers do **not** bill with RC codes like 520 or 055. Their invoices must carry the **SDP service code** [V S4]. RC codes still matter in three cases:
1. A traditional RC vendor that serves an SDP participant "in accordance with [its] program design" invoices with "the same information provided to regional center for billing" [V S4 Enclosure A].
2. HCBS settings assessments refer to the RC codes of group settings [V S18].
3. Vexo users may also serve non-SDP (traditional) consumers.

### 1.2 SDP service codes (DDS table, 2019-02-14 version) [V S1]

| Budget category (code range) | Code | SDP service |
|---|---|---|
| **Living Arrangement (310–330)** | 310 | Respite (Individual and Agency), in-home |
| | 311 | Respite Facility, out-of-home |
| | 312 | Live-In Caregiver |
| | 313 | Homemaker |
| | 314 | Housing Access Supports |
| | 315 | FMS Fiscal Agent (bill payer) |
| | 316 | FMS Co-Employer |
| | 317 | FMS Fiscal/Employer Agent (sole employer) |
| | 320 | Community Living Supports (Individual and Agency) |
| | 321 | Residential Facility |
| **Employment & Community Participation (331–355)** | 331 | Community Integration Supports |
| | 333 | Participant-Directed Goods and Services |
| | 334 | Individual Training and Education |
| | 335 | Employment Supports |
| | 336 | Technology Supports |
| | 337 | Transition Set-Up Expenses |
| | 338 | Non-Medical Transportation |
| | 339 | Prevocational Supports |
| | 340 | Independent Facilitator |
| **Health and Safety (356–399)** | 356 | Environmental Accessibility (Adaptations) |
| | 357 | Acupuncture Services |
| | 358 | Personal Emergency Response Systems |
| | 359 | Home Health Aide |
| | 360 | Communication Support |
| | 361 | Skilled Nursing |
| | 362 | Nutritional Consultation |
| | 363 | Crisis Intervention and Supports |
| | 364 | Behavioral Intervention Services |
| | 365 | Specialized Medical Equipment and Supplies |
| | 366 | Family/Consumer Training |
| | 367 | Dental Services |
| | 368 | Lenses and Frames |
| | 369 | Optometric-Optician Services |
| | 370 | Psychology Services |
| | 371 | Training and Counseling Services for Unpaid Caregivers |
| | 372 | Speech, Hearing and Language |
| | 373 | Chiropractor |
| | 374 | Massage Therapist |
| | 375 | Occupational Therapy |
| | 376 | Physical Therapy |
| | 377 | Vehicle Modifications and Adaptations |
| | 378 | Family Support Services (listed as "Child Day Care Facility") |

Notes:
- The 2026 waiver renewal lists the same set of services, adding "Technology" and others by name [V S3 approval letter]. I found **no newer DDS SDP code table than 2019**. The waiver adds telehealth as a delivery option for some services [V S3]. Not found: any new SDP code number added by the 2026 renewal.
- **Code 099 "General Self-Directed Supports"** is a regional center service for people *before* SDP enrollment (up to 40 hours) [V S20]. It is not a spending plan code.
- There is **no SDP code named "Independent Living Skills"**. [I] ILS-type work in SDP usually maps to **320 Community Living Supports** ("support with personal skill development… activities of daily living") [V S2] or to **334 Individual Training and Education**. Community integration maps to **331**, and supported employment / job coaching maps to **335** [V S2; S4 names "independent contractors who provide job coaching" as SDP Providers]. Which code applies depends on how the participant's spending plan lists the service. **Do not pick it automatically. Read it from the authorization or spending plan.**

### 1.3 Field-visit services: regional center codes and SDP equivalents

| Field service | RC code (traditional) [V] | RC billing unit (post rate reform) [V] | Likely SDP code [I unless noted] | SDP waiver estimate unit [V S3 App. J] |
|---|---|---|---|---|
| Independent living skills | **520** Independent Living Program (S12); **635** Independent Living Specialist (S12) | Hour, subcodes by staffing ratio 1:1=`100`, 1:2=`200`, 1:3=`300`; max 80 hrs/month unless the RC Executive Director grants an exception (S14) | 320 or 334 | 320 (Supported Living component): Hour; 334: Hour |
| Personal assistance | **062** Personal Assistance (S14) | Hour; 1:1/1:2/1:3 = `100/200/300` (S14) | 320 (personal care is part of CLS) | Hour |
| Supported living | **896** Supported Living Services; **894** SLS vendor admin is being folded into 896 (S14) | Hour; `100/200/300` (S14) | 320 | Hour |
| Community integration | **055** Community Integration Training Program; **063** Community Activities Support Services (S18, S15) | **Being phased out.** "These services will not be used in rate reform." Providers had to realign by 2025-05-30. New use needs a DDS exemption (S15, S17). Successors: 531 Day Services, 532, 533, 520, 457, 950/952 (S17) | 331 | 331: **Day** |
| Supported employment | **950** SEP-Group (Hour, ratio subcodes `200`–`800`); **952** SEP-Individual (Hour; Job Development `1D0`, Job Coaching `1J0`); **954** Work Activity Program (S16) | Hour | 335 | 335: Hour |
| Respite (in-home) | 862 agency, 864 worker, 465 participant-directed (S9) | not researched | 310 | Hour (out-of-home 311: Day) |
| Homemaker | 858, 860 (S9) | not researched | 313 | Hour |

Note: 055 does **not** appear in 17 CCR § 54342 [V S12]. It is a DDS-assigned code, confirmed in DDS documents S15, S17 and S18.

### 1.4 Units in SDP

| Rule | Source |
|---|---|
| An SDP Provider "must" bill the FMS at an **hourly or daily** rate, as agreed with the participant. The spending plan may show a projected weekly or monthly cost | [V S4] |
| An "other rate" (not hourly or daily) is allowed but "may not be more than a monthly rate". It needs an annual signed **service agreement** | [V S5] |
| Waiver cost estimate units, by service: Hour (most services, e.g. 320 SLS, 313, 335, 339, 340, 364, 334); **Day** (331 Community Integration, 311 out-of-home respite, 363 crisis, transportation companies); **Month** (312 Live-in caregiver, 314, 333, 358 PERS, FMS); **Miles** (individual transportation, ~$0.73/mi avg); Visit (dental); Piece / Item / Modification / Transition (goods) | [V S3 Appendix J] |
| Not found: any DDS rule for SDP that sets a **15-minute** unit or a rounding rule | — |

[I] The Appendix J units are **estimating units, not binding billing units**. The binding rule is the participant–provider agreement (S4/S5). Support Hour, Day, Month, Mile and Item, and store the exact minutes as well.

### 1.5 Financial Management Service (FMS) models

| | Bill Payer (Fiscal Agent) — code 315 | Co-Employer — 316 | Sole Employer (Fiscal/Employer Agent) — 317 |
|---|---|---|---|
| Used when | Buying from a business or vendor | The participant shares employer duties with the FMS | The participant is the direct employer |
| Employer of record | The business or vendor providing the service | Participant **and** FMS | Participant |
| Who approves timesheets | N/A (the vendor invoices) | Participant | Participant |
| Who pays the worker / taxes | N/A | FMS | FMS (pays). Participant obtains tax ID |
| Who is responsible for EVV | The vendor/agency (it must tie EVV records to the **FMS vendor number**) | FMS | Participant (may use the FMS's EVV system) |
| Monthly FMS fee (English-preferred; 0–4 / 5–10 / 11+ providers) | $230 / $450 / $690 | $380 / $600 / $840 | $380 / $600 / $840 |
| Fee (non-English-preferred) | $255 / $495 / $760 | $420 / $660 / $925 | $420 / $660 / $925 |

Sources: models [V S7]; EVV responsibility [V S10]; fees effective 2023-12-01 [V S8]. Other FMS facts:
- The FMS gives the participant and service coordinator a monthly budget statement. Since the 2025 directive this goes to both the participant and the RC "by the 15th of each month" [V S2, S6].
- The FMS must pay within 30 calendar days of a "complete and accurate" invoice plus a "valid payment request form", and must submit claims to the RC within 30 days [V S6 §14.8, §15.1].
- Since Oct 2026, **San Diego Regional Center** vendors all SDP FMS statewide. Vendor numbers are kept [V S6].

[I] For Vexo, a bill-payer arrangement means our user (a provider business) **is the employer of record**. That means: invoices go to the FMS, and the business owns EVV compliance for EVV-covered codes. A co-employer or sole-employer arrangement means the worker submits **timesheets**, which the participant approves, rather than invoices.

### 1.6 What an SDP provider invoice must contain (DDS minimums)

| Element | Hourly/daily SDP Provider [V S4] | "Other rate" SDP Provider [V S5] |
|---|---|---|
| Rate | Hourly or daily rate | Rate |
| SDP service code | Yes | Yes |
| Date each service/task was provided | Yes | Dates services were provided |
| Description of specific service/task | Yes | Yes |
| Time spent on each service/task | Yes | Time per service for the invoice period |
| Total cost per service/task | Yes | — |
| Attestation | "A statement that all services specified in the invoice have been provided to the participant" | Same |
| Service agreement | Encouraged | **Required, updated annually:** participant info; provider contact; start/end date; services + SDP codes; frequency; rate/unit; responsibilities; termination policy; **signature of participant and provider**; "payment in full" statement. Submitted to the FMS |

Provider certifications DDS requires of all SDP Providers [V S4]:
- services were consistent with the IPP, spending plan and service agreement
- claims are paid from federal/state funds, and falsification may be prosecuted
- records are kept **at least 3 years** from the date of service
- services were provided without discrimination

Further requirements:
- The FMS keeps claims and supporting documents for **5 years** [V S6 §15.4].
- Payments may not include reimbursement for goods the provider bought on the participant's behalf [V S4, S6 §14.5].
- **The FMS can add its own invoice requirements** [V S4 participant guide]. Invoice dates must match the spending plan.
- Signatures: DDS does not list a participant signature *on each invoice*. The participant "approves" invoices [V S4]. Participant and provider signatures are required on the "other rate" service agreement [V S5]. [I] Most FMSs ask for a participant (or authorized representative) approval signature on invoices or timesheets. Treat this as **FMS-configurable**.

### 1.7 Record content required by California regulation (17 CCR § 50604(d)) [V S13]

| Service type | Required record data |
|---|---|
| All | Consumer name + **UCI** (Unique Client Identifier); RC-authorized entrance/exit dates |
| Community-based day programs (e.g. 520, 055) | Dates, place (city/county if natural environments only, otherwise facility address), **start and end times**, daily or hourly units |
| All other services | Date, **start and end times**, **street address** of service, daily or hourly units |
| Transportation | Dates, city/county, miles or trips |
| Goods | Purchase date, seller, items, cost per item |
| Vouchers / participant-directed | Actual provider's name, plus identity details for family-selected workers |

Federal baseline: providers must "keep any records necessary to disclose the extent of services the provider furnishes to beneficiaries" and furnish them on request [V S26, 42 CFR 431.107(b)].

### 1.8 Spending plan and authorization rules

| Rule | Source |
|---|---|
| The spending plan lists: services, **how often** purchased, **SDP service codes**, and the cost of each. The total cannot exceed the certified individual budget | [V S19; S1-era guidance] |
| The RC must **certify** the spending plan (meets IPP goals, not available generically, eligible for FFP) | [V S19, AB 143] |
| Moving funds between service codes or budget categories now needs **RC or IPP team approval** (the old "10% without approval" rule was replaced) | [V S19] |
| The RC must notify the FMS within **3 business days** of a spending plan change | [V S19] |
| Before paying, the FMS confirms: provider qualifications, reasonable rate/wage, service is in the IPP and certified spending plan with funds available, and the service is allowable (FFP, HCBS settings, waiver) | [V S6 §8.3] |
| The FMS reviews time entries, including rest/meal breaks and overtime, and only pays authorized services at spending-plan rates | [V S6 §14.9] |

### 1.9 EVV in California

Federal rule [V S22, S11]:
- Section 12006 of the Cures Act (SSA §1903(l)) requires EVV for Medicaid **personal care services (PCS)** and **home health care services (HHCS)** that involve an in-home visit.
- Covered authorities: §1905(a)(24), 1915(c), (i), (j), (k), 1115, and HHCS under 1905(a)(7).
- Deadlines: PCS by 2020-01-01, HHCS by 2023-01-01.
- **Six data elements:**
  1. type of service performed
  2. individual receiving the service
  3. date of service
  4. location of service delivery
  5. individual providing the service
  6. time the service begins and ends
- Exclusions: live-in caregivers (not an "in-home visit") and PACE. CMS says web timesheets alone do not satisfy EVV.

California [V S9, S10, S11]:
- EVV started for regional center PCS in Jan 2022, and for HHCS and **SDP** on **2023-01-01**.
- The state system is **CalEVV** (Sandata). Alternate EVV systems feed the CalEVV aggregator.
- Live-in staff are exempt with an attestation form.
- An SDP EVV visit must carry the participant **UCI**, the **service code**, and the **FMS vendor number** under which the service is billed.

| EVV-covered code | Program | Type |
|---|---|---|
| 310 Respite, 313 Homemaker, 320 Community Living Supports | SDP | PCS |
| 359 Home Health Aide, 361 Skilled Nursing, 372 Speech/Hearing/Language, 375 OT, 376 PT | SDP | HHCS (361 always; the others when provided by agencies) |
| 465, 862, 864 Respite; 896 Supported Living; 858, 860 Homemaker; **062 Personal Assistance** | RC | PCS |
| 460, 742, 744 Nursing; 854, 856 Home health; 707, 773, 772 therapies | RC | HHCS |

**Not EVV-covered on DDS's list:** 520 ILS, 055/063 community integration, 950/952 supported employment, and SDP 331/334/335 [V S9, S11, by omission]. [I] Even so, capturing the six elements on every visit costs us nothing and makes the session note audit-proof.

---

## 2. Federal / national HCPCS Level II codes for HCBS and self-direction

Source: CMS HCPCS **October 2026** alpha-numeric file (S21). All descriptors below are copied from the official long descriptor. [V] Every code listed is present in that file.

### 2.1 Codes and official descriptors

| Code | Official long descriptor (CMS, Oct 2026) | Unit |
|---|---|---|
| T1019 | Personal care services, per 15 minutes, not for an inpatient or resident of a hospital, nursing facility, ICF/MR or IMD, part of the individualized plan of treatment (code may not be used to identify services provided by home health aide or certified nurse assistant) | 15 min |
| T1020 | Personal care services, per diem, (same exclusions as T1019) | Per diem |
| S5125 | Attendant care services; per 15 minutes | 15 min |
| S5126 | Attendant care services; per diem | Per diem |
| S5130 | Homemaker service, NOS; per 15 minutes | 15 min |
| S5131 | Homemaker service, NOS; per diem | Per diem |
| S5135 | Companion care, adult (e.g., IADL/ADL); per 15 minutes | 15 min |
| S5136 | Companion care, adult (e.g., IADL/ADL); per diem | Per diem |
| S5150 / S5151 | Unskilled respite care, not hospice; per 15 minutes / per diem | 15 min / diem |
| T1005 | Respite care services, up to 15 minutes | 15 min |
| S5100 / S5102 | Day care services, adult; per 15 minutes / per diem | 15 min / diem |
| H2014 | Skills training and development, per 15 minutes | 15 min |
| H2015 | Comprehensive community support services, per 15 minutes | 15 min |
| H2016 | Comprehensive community support services, per diem | Per diem |
| H2017 / H2018 | Psychosocial rehabilitation services, per 15 minutes / per diem | 15 min / diem |
| H2023 | Supported employment, per 15 minutes | 15 min |
| H2024 | Supported employment, per diem | Per diem |
| H2025 | Ongoing support to maintain employment, per 15 minutes | 15 min |
| H2026 | Ongoing support to maintain employment, per diem | Per diem |
| T2012 / T2013 | Habilitation, educational, waiver; per diem / per hour | Diem / **hour** |
| T2014 / T2015 | Habilitation, prevocational, waiver; per diem / per hour | Diem / **hour** |
| T2016 | Habilitation, residential, waiver; per diem | Per diem |
| T2017 | Habilitation, residential, waiver; 15 minutes | 15 min |
| T2018 | Habilitation, supported employment, waiver; per diem | Per diem |
| T2019 | Habilitation, supported employment, waiver; per 15 minutes | 15 min |
| T2020 / T2021 | Day habilitation, waiver; per diem / per 15 minutes | Diem / 15 min |
| T2025 | Waiver services; not otherwise specified (NOS) | **No unit in descriptor** (state defines) |
| T2038 | Community transition, waiver; per service | Per service |
| T2028 | Specialized supply, not otherwise specified, waiver | Item |
| **T2040** | Financial management, self-directed, waiver; per 15 minutes | 15 min |
| **T2050** | Financial management, self-directed, waiver; per diem | Per diem |
| **T2041** | Supports brokerage, self-directed, waiver; per 15 minutes | 15 min |
| **T2051** | Supports brokerage, self-directed, waiver; per diem | Per diem |
| T2022 / T2023 | Case management, per month / Targeted case management; per month | Month |
| T2024 | Service assessment/plan of care development, waiver (VA VDC uses it for the one-time assessment fee, see §3) | No unit in descriptor |
| T2039 | Vehicle modifications, waiver; per service | Per service |
| T2001 / T2002 / T2003 | Non-emergency transportation; patient attendant/escort / per diem / encounter/trip | Varies |
| A0080 / A0090 | Non-emergency transportation, per mile – volunteer vehicle / individual with vested interest | Mile |
| S5165 | Home modifications; per service | Per service |
| S5170 | Home delivered meals, including preparation; per meal | Meal |
| S9122 | Home health aide or certified nurse assistant, providing care in the home; per hour | Hour |
| T1000 | Private duty / independent nursing service(s) – licensed, up to 15 minutes | 15 min |
| **G9006** | **Coordinated care fee, home monitoring** | — |

Flags:
- **G9006 is not an HCBS or self-direction code.** It is a "coordinated care fee" code (G9001–G9012 family). Do not seed it.
- **The only national codes that say "self-directed" are T2040, T2041, T2050 and T2051** (FMS and supports brokerage) [V S21, full-text search of the file]. There is no national HCPCS code for "a participant-directed version of service X". States show self-direction through modifiers or their own rate codes.
- [I, background, not re-verified this session] T-codes were created for state Medicaid agencies. S-codes are temporary national non-Medicare codes. Both are commonly used by Medicaid HCBS programs. H-codes are behavioral health / alcohol-drug codes that many states reuse for HCBS skills and employment services.

### 2.2 Modifiers commonly used for HCBS / self-direction (official CMS descriptors, Oct 2026 file) [V S21]

| Modifier | Official descriptor | Typical HCBS use [I] |
|---|---|---|
| U1–U9, UA–UD | "Medicaid level of care 1 … 13, **as defined by each state**" | Most common way states mark **self-directed**, provider type, or rate tier. The meaning is 100% state-specific |
| HQ | Group setting | Group (1:2+) delivery |
| UN / UP / UQ / UR / US | Two / three / four / five / six or more patients served | Staffing ratio (note: Medicare uses these for portable X-ray) |
| TT | Individualized service provided to more than one patient in same setting | Shared staff |
| HI | Integrated mental health and intellectual disability/developmental disabilities program | DD programs |
| HM / HN / HO / HP | Less than bachelor / bachelor's / master's / doctoral level | Staff credential tier |
| TF / TG | Intermediate / complex/high tech level of care | Acuity tier |
| UF / UG / UH / UJ | Services provided in the morning / afternoon / evening / at night | Shift differential |
| TU / TV | Special payment rate, overtime / holidays/weekends | Overtime/holiday rates (relevant to co-/sole-employer) |
| UK | Services provided on behalf of the client to someone other than the client (collateral relationship) | Family training, collateral contacts |
| TN | Rural/outside providers' customary service area | Rural add-on |
| SE | State and/or federally-funded programs/services | Funding marker |
| HW / HX | Funded by state mental health agency / county/local agency | Funding marker |
| GT / 95 | Via interactive audio and video telecommunication systems (GT). 95 is a CPT modifier, not in the HCPCS file | Telehealth (CA SDP renewal added telehealth) |
| KX | Requirements specified in the medical policy have been met | Over-limit or exception approved |

Not found: any **national** HCPCS modifier meaning "self-directed" or "participant-directed". Example of a state convention: Oregon uses its own proc/mod pairs, e.g. `OR526` + `NA` / `RB` / `R3` [V S24].

### 2.3 How California maps to HCPCS

Not found: any public DDS crosswalk from SDP codes (310–399) or RC codes (520, 055…) to HCPCS. Regional center providers and FMSs bill DDS/RCs using DDS service codes and subcodes, not HCPCS [V S4, S6, S14]. [I] HCPCS is needed only if Vexo serves other states or payers (Medi-Cal managed care, IHSS-adjacent, VA). Keep HCPCS as a second code system, not the main one for California.

### 2.4 15-minute units and the "8-minute rule"

| Point | Status |
|---|---|
| The 8-minute rule is a **Medicare** rule for **timed CPT outpatient therapy codes** (CMS IOM 100-04, Ch. 5). Bill a unit if 8 or more minutes remain after dividing total timed minutes by 15 | [V Noridian page, last updated 2024-11-14: https://med.noridianmedicare.com/web/jeb/article-detail/-/view/10525/medicare-billing-for-physical-occupational-and-speech-therapy-based-on-minutes] |
| It does **not** automatically apply to Medicaid HCBS. Each state sets its own unit and rounding rule | [I, supported by the examples below] |
| Kentucky changed its 1915(c) waiver rounding from "exact 15-minute increments" to rounding up at **8 minutes**, to match its state plan and Medicare | [V S27 KY] |
| Oklahoma (ADvantage waiver): no unit billed when "not more than one-half of a timed unit" is performed (under 8 minutes for a 15-minute unit) | [V S27 OK] |
| California DDS: hourly billing units for RC services. SDP is hourly/daily per agreement. No CA rounding rule found | Not found |

[I] Make rounding a **per-payer/per-code configuration**: `none_exact`, `round_half_up_8min`, `floor_full_unit`, `round_nearest`, `aggregate_daily_then_round`. Always store the raw minutes too.

---

## 3. Comparison: other self-direction programs

| Program | Code system | Units | Self-direction marker | FMS / intermediary | Source |
|---|---|---|---|---|---|
| **New York OPWDD Self-Direction** | 4-digit NY Medicaid **rate codes** (eMedNY), not HCPCS | Mostly **1/4 hour**. Live-in caregiver = month. Goods & services = **$10 unit** | Separate "Via FI" rate codes, e.g. 4765 Com Hab Via FI Ind 1/4 hr, 4766 Grp; 4769–4772 SEMP Via FI; 4764 Respite Via FI; 4778 Support Broker; 4777 Live-in Caregiver (month); 4785 Ind Goods & Svcs ($10 unit). Agency-supported: 4755/4756 Com Hab Agy Sup | Fiscal Intermediary, monthly codes 4787/4788/4789 (Levels 1–3) | [V S23, as of 5/1/25] |
| **Oregon ODDS (I/DD)** | State **proc codes** `ORnnn` + 2-character state modifiers, in the eXPRS system. Also uses a few HCPCS (A9999, S5165, T2039) | Hourly (e.g. OR526 "Hourly Attendant Care"); OR507 daily / OR508 hourly relief care; mileage OR004 | Modifier sets ratio/setting: NA (1:1 in-home), RB (1:2), R3 (1:3), RC/RS (1:1 community), SW (wrap-around), W1/W2 (facility/community); OR525 for paid-parent attendant care | Personal Support Workers paid via eXPRS (Mobile-EVV) | [V S24, updated 2025-10-16] |
| **VA Veteran Directed Care (VDC)** | **UB-04 / EDI 837I**, revenue code **3109** ("Other Adult Care", fallback 0571), HCPCS **T1020** for monthly claims and **T2024** for the one-time assessment fee | **Days** of care each month against a monthly **case-mix rate** (e.g. King County WA case-mix "E" = $3,555/mo in the example) | Whole program is veteran-directed. Authorization number required (837 Loop 2300 REF*9F, UB-04 FL 63) | Aging/disability network provider + FMS. Monthly service report | [V S25, Oct 2024] |
| **California SDP** | DDS SDP codes 310–399 | Hour / day / "other" (≤ monthly) per agreement | Whole program is self-directed. FMS model = 315/316/317 | FMS bills RC. Provider invoices FMS | §1 |

Takeaways [I]:
- Every program uses a **different code system**: state rate codes (NY), state proc+modifier (OR), HCPCS+revenue codes (VA), state SDP codes (CA). The data model must treat `code_system` as a first-class field.
- Self-direction is shown in three different ways: a separate code (NY "Via FI"), a modifier (OR, and states using U-modifiers), or the program itself (CA SDP, VA VDC).
- The 15-minute unit dominates in HCPCS and NY. CA is hourly/daily. VA is days within a month.

---

## 4. Implications for the Vexo data model

### 4.1 Proposed entities and fields

**`CodeSystem`** (reference data, versioned)

| Field | Example | Notes |
|---|---|---|
| `id` | `CA-SDP`, `CA-RC`, `HCPCS`, `NY-OPWDD-RATE`, `OR-EXPRS`, `VA-VDC` | |
| `authority` | "CA DDS", "CMS" | |
| `source_url`, `source_version`, `effective_from`, `effective_to` | S1 / "2019-02-14" | **Required**, because code tables change |

**`ServiceCode`** (reference data)

| Field | Example (CA-SDP) | Example (CA-RC) | Example (HCPCS) |
|---|---|---|---|
| `code_system_id` | CA-SDP | CA-RC | HCPCS |
| `code` | `320` | `520` | `H2014` |
| `subcode` | — | `100` (1:1) | — |
| `descriptor` (official text, verbatim) | Community Living Supports (Individual and Agency) | Independent Living Program | Skills training and development, per 15 minutes |
| `budget_category` | `LIVING_ARRANGEMENT` / `EMPLOYMENT_COMMUNITY` / `HEALTH_SAFETY` | — | — |
| `default_unit_type` | `HOUR` | `HOUR` | `MIN15` |
| `staffing_ratio` | — | `1:1` | via modifier |
| `evv_required` | true (320) | false (520) / true (062) | state-defined |
| `evv_category` | `PCS` / `HHCS` / null | | |
| `status`, `effective_from/to`, `replaced_by` | | 055 → `deprecated`, needs exemption | |
| `crosswalk[]` | optional links to other systems | | |

**`Authorization`** (per participant × service). One per spending plan line or RC authorization.

| Field | Notes |
|---|---|
| `participant_ref` (UCI for CA) | Treat UCI as sensitive. Shared with the EVV employer of record only for EVV [V S10] |
| `payer_type` | `RC_DIRECT`, `FMS`, `MEDICAID_MCO`, `VA`, `PRIVATE` |
| `fms_name`, `fms_vendor_number`, `fms_model` (`BILL_PAYER`/`CO_EMPLOYER`/`SOLE_EMPLOYER`) | The FMS vendor number must be on EVV records [V S10] |
| `regional_center`, `authorization_number` | The RC authorization (POS) number. For VA, the referral number goes in 837 REF*9F |
| `service_code_id`, `modifiers[]` (ordered, max 4) | |
| `start_date`, `end_date` | Must match spending plan dates [V S4] |
| `authorized_units`, `unit_type`, `period` (`MONTH`/`PLAN_YEAR`/`TOTAL`) | e.g. 520 = up to 80 hrs/month [V S14] |
| `units_used`, `units_remaining` (derived) | Block or flag a draft invoice that exceeds this |
| `rate_per_unit`, `currency`, `rate_source` (`NEGOTIATED`/`DEPT_SET`/`FEE_SCHEDULE`) | SDP = negotiated; RC = DDS rate model per RC |
| `frequency` (e.g. "6 hrs/week") | Required in the spending plan and service agreement [V S19, S5] |
| `service_agreement_id` | Required for "other rate" [V S5] |

**`Visit` / `SessionNote`** (evidence → note)

| Field | Why |
|---|---|
| `service_type` (code ref) | EVV element 1 |
| `participant_ref` | EVV element 2 |
| `service_date` | EVV element 3 |
| `location` (street address + optional GPS at check-in/out; or city/county for natural environments) | EVV element 4; 17 CCR 50604 |
| `provider_worker_id` | EVV element 5 |
| `start_time`, `end_time` (timezone-aware), `break_minutes` | EVV element 6; 50604; FMS time-entry review [V S6 §14.9] |
| `tasks[]` each with `description`, `minutes` | SDP invoice needs a description and time **per task** [V S4] |
| `staffing_ratio` / `group_size` | Drives CA subcode (100/200/300) or HCPCS HQ/UN–US |
| `delivery_mode` (`IN_PERSON`/`TELEHEALTH`) | CA SDP renewal adds telehealth [V S3] |
| `live_in_exempt` (+ attestation ref) | EVV exemption [V S11] |
| `evv_record_id`, `evv_system` (CalEVV / alt) | |
| `participant_direction` (who directed, choices made) | Already in our receipt model. Supports person-centred documentation |

**`InvoiceLine`**

| Field | Notes |
|---|---|
| `service_code`, `subcode`, `modifiers[]` | |
| `service_date`, `task_description`, `raw_minutes`, `billed_units`, `unit_type`, `rounding_rule_applied` | Keep the raw value and the billed value |
| `rate_per_unit`, `line_total` | |
| `authorization_id` | |

**`Invoice`**

| Field | Notes |
|---|---|
| `billed_to` (FMS / RC / payer), `period_start/end` | |
| `attestation_text` | Default: "All services specified in this invoice have been provided to the participant." [V S4] |
| `provider_certifications[]` | The four S4 statements |
| `signatures[]` (`role`: provider / participant / authorized_rep / FMS; `name`, `signed_at`, `method`) | Which roles are required = FMS config |
| `retention_until` | Max of provider 3 yrs [S4], FMS 5 yrs [S6], 50604 rules |

### 4.2 Must be configurable, not hard-coded

| Item | Varies by |
|---|---|
| Code table + version | State, program, and date (CA SDP 2019 table; RC subcodes since 2025; 055/063 deprecated) |
| Unit type per code | Program, and the individual agreement (SDP hourly/daily/other) |
| Rounding rule (8-minute, exact, floor) | State / payer / code |
| Rate per unit | SDP: per participant-provider agreement. RC: per regional center rate workbook. Other states: fee schedules |
| Modifier meanings (U1–UD especially) | State |
| EVV-required codes and EVV system | State (CA list per S9/S11), employer-of-record model |
| Required invoice fields and signatures | **Each FMS** can add requirements beyond the DDS minimum [V S4] |
| Monthly or hourly caps (e.g. 520 ≤ 80 h/mo) | Service code / RC exception |
| Budget category transfer rules | State law (CA AB 143, 2025) |
| Record retention period | Program / role |
| Claim format (FMS invoice PDF, 837P/837I, UB-04, eXPRS) | Payer |

### 4.3 Seed data suggestion [I]

- Replace `DEMO-ILS` with real rows: **CA-SDP 320, 331, 334, 335, 310, 313** and **CA-RC 520-100/200/300, 062-100/200/300, 952-1D0/1J0, 950-200…800**. Mark CA-RC 055 and 063 as `deprecated (exemption required)`.
- Add HCPCS rows from §2.1 for other states, with `code_system=HCPCS`, `version=2026-10`. Exclude G9006.
- Default EVV flag `true` for CA-SDP 310/313/320/359/361/372/375/376 and CA-RC 062/896/858/860/862/864/465.

---

## 5. Open questions and uncertainties

| # | Uncertainty | How to resolve |
|---|---|---|
| U1 | DDS's public SDP code table is the **2019** version. The waiver was renewed in 2026 (effective 2026-07-01) and may have changed services or codes (telehealth, technology split into consultation/equipment/support in Appendix J). No newer table found | Ask DDS (sdp@dds.ca.gov) or a regional center / FMS for the current SDP code list |
| U2 | Which SDP code an "ILS" provider should use (320 vs 334) depends on each participant's spending plan | Read it from the authorization. Never infer it |
| U3 | No California rounding rule for SDP or RC hourly units found | Ask the target FMSs (each may differ) |
| U4 | FMS-specific invoice and timesheet forms (participant signature, time in/out format) are not public DDS rules | Collect templates from 2–3 major SDP FMSs before finalising required fields |
| U5 | FMS rates: latest confirmed schedule effective 2023-12-01. The Oct 2026 FMS standards directive did not restate rates | Re-check the DDS SDP FMS page |
| U6 | Regional center rates for 520/062/952 are per-RC rate workbooks (Jan 2026 rate models), not statewide | Load per RC if we support traditional RC billing |
| U7 | No national "self-directed" modifier exists. U-modifier meanings must come from each state's manual | Per-state configuration |
| U8 | Record retention differs: SDP provider 3 years (S4), FMS 5 years (S6), 17 CCR 50604 for vendors (5 years per secondary source; I did not re-read the subsection) | Use the longest applicable (≥5 years) |
