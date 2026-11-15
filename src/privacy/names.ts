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
nobody somebody someone everyone anyone everybody anybody who which whoever both either neither each every
sorry wow oh ah um uh hmm great awesome nice cool excellent perfect alright next later
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

/**
 * Capitalised words that are commonly NOT person names (places, organisations, brands, programs,
 * transit, holidays). A capitalised pair containing one of these is never guessed to be a name.
 */
const NON_NAME_RAW = `
new san santa los las el la le de del du saint st fort port mount mt lake river bay beach valley hills hill heights
springs spring falls park garden gardens square bridge tower towers island islands harbor harbour county city town
village state states united kingdom republic north south east west northern southern eastern western central upper lower
golden gate star wars greater downtown uptown midtown airport station terminal mall plaza market center centre building hall house
target walmart costco safeway kroger publix aldi lidl trader whole foods dollar general tree family depot lowe's
home goods best buy cvs walgreens rite aid starbucks mcdonald's subway amazon google apple microsoft facebook
instagram tiktok youtube netflix uber lyft bart muni metro transit amtrak greyhound line express rapid route
department dept office agency administration services service social security medicaid medicare medi-cal calfresh
snap wic ssi ssdi dmv irs usps fedex ups bank credit union insurance health healthcare medical care clinic hospital
pharmacy urgent emergency regional university college school academy institute high middle elementary primary
community program programs day center club league team church temple mosque synagogue library museum zoo theater
theatre cinema gym ymca ywca goodwill salvation army red cross food stamps housing authority court police fire
monday tuesday wednesday thursday friday saturday sunday christmas easter halloween thanksgiving hanukkah ramadan
diwali new year's valentine's independence labor memorial veterans
english spanish french chinese mandarin cantonese vietnamese korean tagalog arabic russian
dear hi hello hey thanks thank good morning afternoon evening night happy merry
okay ok yes no please sorry great nice cool awesome wow oh well so
`;
export const NON_NAME_WORDS: ReadonlySet<string> = new Set(NON_NAME_RAW.split(/\s+/).filter(Boolean));
