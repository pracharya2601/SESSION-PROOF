/**
 * Built-in lexicons for the deterministic name detector. Deliberately excludes
 * first names that are also months / common words ("May", "June", "Will", "Grant"…).
 */
const FIRST_NAMES_RAW = `
james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony
donald steven paul andrew joshua kenneth kevin brian george timothy ronald edward jason jeffrey ryan jacob
gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory alexander frank
patrick raymond jack dennis jerry tyler aaron jose adam nathan henry douglas zachary peter kyle noah ethan
jeremy walter christian keith roger terry austin sean gerald carl harold dylan arthur lawrence jordan jesse
bryan billy bruce gabriel joe logan alan juan albert willie elijah wayne randy vincent mason roy ralph
bobby russell bradley philip eugene louis harry howard fred liam lucas oliver aiden carlos luis miguel
jorge diego antonio manuel pedro ricardo javier marco ahmed mohammed muhammad ali omar hassan raj ravi
arjun vikram rahul amit sanjay wei chen li ming hiroshi kenji takeshi dmitri ivan sergei
mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty margaret sandra
ashley kimberly emily donna michelle carol amanda melissa deborah stephanie rebecca sharon laura cynthia
kathleen amy angela shirley anna brenda pamela emma nicole helen samantha katherine christine debra rachel
carolyn janet catherine maria heather diane ruth julie olivia joyce virginia victoria kelly lauren christina
joan evelyn judith megan andrea cheryl hannah jacqueline martha gloria teresa sara madison frances kathryn
janice jean abigail alice judy sophia denise beverly danielle theresa marilyn diana natalie brittany
charlotte marie kayla alexis lori jane doris tiffany ava mia isabella amelia harper ella chloe zoe lily
grace aria scarlett layla nora riley ellie aubrey leah stella hazel violet aurora savannah audrey brooklyn
claire skylar lucy paisley everly caroline nova genesis emilia kennedy maya willow kinsley naomi elena
sofia camila valeria lucia gabriela fatima aisha priya ananya deepa sunita mei yuki keiko olga natasha
irina rosa carmen guadalupe juana luz ana beatriz yolanda tanya monica veronica wendy tammy yvonne
jasmine alyssa brianna destiny erin crystal kristen courtney molly jill marsha lydia ellen peggy
`;

export const FIRST_NAMES: ReadonlySet<string> = new Set(FIRST_NAMES_RAW.split(/\s+/).filter(Boolean));

/** Capitalized words that are never (part of) a person name in our domain. */
const STOP_RAW = `
i i'm i'll i've me my we we're our us you your he she it they them their this that these those there here
the a an and or but so if then than when while where what who why how yes no not okay ok hi hello hey thanks
thank please well also just now today tomorrow yesterday tonight next last first second later soon again
monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun
january february march april may june july august september october november december
jan feb mar apr jun jul aug sep sept oct nov dec
provider participant client speaker staff caregiver guardian unknown interviewer host guest coach worker aide
nurse doctor therapist counselor manager supervisor parent mom dad mother father sister brother
library park street avenue road boulevard lane drive court way place terrace bus route stop station center
centre school hospital clinic store market office church bank pharmacy hall city county state north south
east west main community food budget weekly daily medicaid medicare ssn dob id mrn social security insurance
program service services session plan goal goals note notes zip apt unit suite
good great fine sure right let let's can could would should will shall might must did do does done
is are was were be been being have has had get got go going went come came see saw look said say tell told
american english spanish christmas thanksgiving easter
`;

export const NAME_STOPWORDS: ReadonlySet<string> = new Set(STOP_RAW.split(/\s+/).filter(Boolean));

/** Speaker labels that are roles, not identities — kept verbatim. */
export const ROLE_SPEAKERS: ReadonlySet<string> = new Set(
  `provider participant client speaker staff caregiver guardian unknown interviewer host guest coach worker aide
  nurse doctor therapist counselor manager supervisor parent narrator system assistant user agent other
  interpreter observer family member`
    .split(/\s+/)
    .filter(Boolean),
);
