// Hair services from the printed Sahasra menu. Prices are exact; `null` member = "NA" on the menu.
// Shape: { name, category, audience, price: [regular, member] | variants: [[label, regular, member], ...], description, active? }

const SML = ["Small", "Medium", "Large"]
const SMLong = ["Small", "Medium", "Long"]
const SHML = ["Short", "Medium", "Long"]
const tri = (labels, reg, mem) => labels.map((l, i) => [l, reg[i], mem ? mem[i] : null])

export const haircuts = [
  {
    name: "Classic Hair Cut",
    category: "HAIRCUTS & HAIR WASH",
    audience: "UNISEX",
    variants: [
      ["Trim, U-Cut, Straight Cut", 450, 400],
      ["Fringe / Bongs", 250, null],
    ],
    description:
      "The Classic Hair Cut covers the everyday, uncomplicated cuts: a trim to tidy split or uneven ends, a U-cut that curves the back into a soft U shape, or a straight cut that keeps one clean line across the hair. Choose the Fringe / Bongs option when you only want the front fringe reshaped between full haircuts. Your stylist will talk through the length and shape before cutting, so you leave with a neat, easy-to-manage finish. It is a good fit for regular maintenance visits and for anyone who wants a simple, tidy cut rather than a layered or creative one. The Fringe / Bongs option is a quick, fringe-only service.",
  },
  {
    name: "Advance Hair Cut",
    category: "HAIRCUTS & HAIR WASH",
    audience: "UNISEX",
    price: [1200, 1100],
    description:
      "The Advance Hair Cut is the salon's layered and creative cutting service. It covers a layer cut, where the hair is cut in graduated lengths to add movement and shape, as well as a creative cut for a more personalised or trend-led look. A hair wash is included in the service, so your hair is cleansed before and after the cut and you leave ready to style. Your stylist will discuss your hair type, the length you want to keep and how much maintenance you are comfortable with before starting. Choose this over the Classic Hair Cut when you want shape, texture or a fresh style, not just a tidy-up.",
  },
  {
    name: "Layer Trim",
    category: "HAIRCUTS & HAIR WASH",
    audience: "UNISEX",
    price: [700, 650],
    description:
      "Layer Trim is a light refresh for hair that already has layers. Instead of a full re-cut, the stylist trims the ends and tidies the existing layers so the shape stays balanced as your hair grows out. It keeps the length largely as it is while removing straggly or uneven ends, which makes it a sensible choice between full haircuts when the style still suits you but has lost its definition. It is quicker and lighter than the Advance Hair Cut, so book it when you only need the layers maintained and do not want a new look. Tell your stylist if you would like slightly more length taken off.",
  },
  {
    name: "Hair Wash",
    category: "HAIRCUTS & HAIR WASH",
    audience: "UNISEX",
    variants: tri(SML, [400, 500, 600], [350, 450, 550]),
    description:
      "A complete wash-and-dry service that includes shampoo, conditioning and a blast dry. Your hair is cleansed, conditioned to leave it softer and easier to handle, and then dried with a blast dry so it finishes smooth and ready to wear. The price depends on your hair size: Small, Medium or Large, so choose the one that matches the volume and length of your hair. It suits anyone who wants fresh, clean hair for an event, a meeting or simply for the week ahead, without the extra steps of a full styling service. For extra-long hair, please check with the front desk before booking.",
  },
  {
    name: "Advanced Hair Wash",
    category: "HAIRCUTS & HAIR WASH",
    audience: "UNISEX",
    variants: tri(SML, [700, 800, 900], [650, 750, 850]),
    description:
      "Advanced Hair Wash is the upgraded version of the standard wash, still built around shampoo, conditioning and a blast dry but offered as a more thorough, higher-tier service. It is meant for those who want a more careful wash and finish than the basic option. Pricing follows your hair size, Small, Medium or Large, so pick the size that fits your hair. It works well before an occasion or whenever you want your hair to feel properly cleansed, conditioned and neatly dried. If your hair is extra long, ask the front desk before booking so the right time and price can be arranged for you.",
  },
  {
    name: "Hair Cut",
    category: "HAIRCUTS & HAIR WASH",
    audience: "UNISEX",
    price: [1500, null],
    description:
      "Hair Cut is listed on the salon's premium hair-cut price list, a separate page of the menu from the Classic and Advance cuts, and it carries no member rate. It is a full haircut service for customers who want the salon's premium level of attention. Your stylist will go through the shape, length and finish you want, then cut accordingly. Because the printed menu does not describe what the premium tier adds beyond the cut itself, please confirm details with the front desk if you want to know exactly how it differs from the Classic Hair Cut or Advance Hair Cut before you book.",
  },
  {
    name: "Hair Wash (On Words)",
    category: "HAIRCUTS & HAIR WASH",
    audience: "UNISEX",
    price: [350, null],
    description:
      "Hair Wash (On Words) is the name exactly as printed on the salon's premium hair-cut price list, where the 'On Words' wording shows the price is a starting figure rather than a fixed one. It is a hair-washing service for customers who only want their hair cleansed, without a cut or styling. The final charge can vary with the length and volume of your hair, so please confirm the price with the front desk when you arrive. If you prefer a wash with set prices by hair size and a conditioning and blast-dry finish, the separate Hair Wash service on the menu lists Small, Medium and Large options.",
  },
  {
    name: "Straight One Length (On Words)",
    category: "HAIRCUTS & HAIR WASH",
    audience: "UNISEX",
    price: [350, null],
    description:
      "Straight One Length (On Words) is printed on the salon's premium hair-cut price list with the 'On Words' wording, which indicates a starting price. The name describes a straight, single-length cut, where the hair is trimmed to one even length across, giving a clean, blunt line without layers. It suits customers who want a simple, uniform finish and a tidy hemline. Because the final price can depend on your hair length and thickness, please confirm it with the front desk before the service. For layered or creative looks, choose the Advance Hair Cut or Layer Trim instead.",
  },
  {
    name: "Wash",
    category: "HAIRCUTS & HAIR WASH",
    audience: "UNISEX",
    price: [300, null],
    description:
      "Wash is the most basic hair-washing entry on the salon's premium hair-cut price list, and it carries no member rate. It is intended for customers who simply want their hair washed, with no conditioning treatment, cut or styling added. If you would like conditioning and a blast dry as part of the visit, the Hair Wash service on the menu includes shampoo, conditioning and a blast dry, with prices by hair size. The printed menu gives no further detail on this entry, so confirm with the front desk if you need to know exactly what is included before you book.",
  },
]

export const styling = [
  {
    name: "Blow Dry",
    category: "HAIR STYLING",
    audience: "UNISEX",
    variants: tri(SMLong, [700, 800, 900], [650, 750, 850]),
    description:
      "A straight, finished blow dry that leaves hair smooth, neat and ready for the day. After the hair is dried, your stylist blow-dries it into a straight finish with a polished, controlled look. Price is by hair length, with Small, Medium and Long options, so choose the length closest to your own. It is popular before parties, meetings and photographs, or whenever you want salon-finished hair without a cut or colour. The blow dry is a styling service, so wash, conditioning and blast dry are separate services on the menu. For extra-long hair, please ask the front desk before booking.",
  },
  {
    name: "Advance Blow Dry",
    category: "HAIR STYLING",
    audience: "UNISEX",
    variants: tri(SMLong, [850, 950, 1050], [800, 900, 1000]),
    description:
      "Advance Blow Dry goes beyond a straight finish by shaping the hair into curls, either outward or inward, using a blow-dry technique. Outward curls flick the ends away from the face for a fuller, more dramatic shape, while inward curls turn the ends under for a softer, neater look. Pricing is by length, Small, Medium or Long, and the extra shaping is why it costs more than the standard Blow Dry. It is a good choice for occasions, parties or any day you want volume and movement instead of a flat finish. Tell your stylist which direction of curl you prefer. Extra-long hair should be confirmed with the front desk.",
  },
  {
    name: "Ironing",
    category: "HAIR STYLING",
    audience: "UNISEX",
    variants: [
      ["Medium", 1200, null],
      ["Long", 1500, null],
    ],
    description:
      "Ironing is a heat-styling service where a flat iron is used to straighten the hair section by section, giving a sleek, smooth finish that lasts until your next wash. It is priced by length, Medium or Long, so choose the length that matches your hair. It suits customers who want a straight, polished look for an occasion or for the week, without committing to a chemical straightening treatment. Because it uses heat, it is a styling service rather than a lasting change, and your hair will return to its natural texture after washing. Extra-long hair should be confirmed with the front desk before booking.",
  },
  {
    name: "Ironing Curls",
    category: "HAIR STYLING",
    audience: "UNISEX",
    variants: [
      ["Medium", 1500, null],
      ["Long", 1800, null],
    ],
    description:
      "Ironing Curls uses a flat iron to create curls and waves rather than a straight finish, giving soft, bouncy movement through the hair. Your stylist sections the hair and shapes each section with the iron, so the curls look even and polished. It is priced by length, Medium or Long, and it costs more than plain ironing because it takes more shaping work. Choose it for parties, weddings and photographs when you want curls without the commitment of a perm. The look is a styling finish, so it softens over the day and relaxes completely after your next wash. Extra-long hair should be confirmed with the front desk.",
  },
  {
    name: "Tongs",
    category: "HAIR STYLING",
    audience: "UNISEX",
    variants: [
      ["Medium", 1500, null],
      ["Long", 1800, null],
    ],
    description:
      "Tongs styling uses a heated curling tong to wrap the hair into defined curls or waves, producing a rounder, more sculpted curl than a flat iron. Each section is wound around the barrel and released, building a full, polished style. Pricing depends on your length, Medium or Long, because longer hair needs more sections and time. It suits celebrations, events and photo shoots where you want curls that hold their shape through the day. As with any heat styling, it is temporary and will drop out once you wash your hair. Please check with the front desk if your hair is extra long before you book.",
  },
  {
    name: "Updo (Classic)",
    category: "HAIR STYLING",
    audience: "UNISEX",
    variants: [
      ["Medium", 1200, null],
      ["Long", 1500, null],
    ],
    description:
      "Updo (Classic) is a traditional pinned-up hairstyle, such as a neat bun or twist, designed to keep hair off the neck and face while still looking elegant. Your stylist gathers and secures the hair so it stays in place through an event. It is priced by length, Medium or Long, and it is the simpler of the two updo options on the menu, ideal for functions, office events and festive occasions when you want a clean, dependable style. If you want a more elaborate or textured finish, take a look at Updo (Advance). Extra-long hair should be confirmed with the front desk before booking.",
  },
  {
    name: "Updo (Advance)",
    category: "HAIR STYLING",
    audience: "UNISEX",
    variants: [
      ["Medium", 1500, null],
      ["Long", 1800, null],
    ],
    description:
      "Updo (Advance) is the more detailed pinned-up style, built for occasions where the hairstyle is part of the look. Instead of a simple bun, it can involve more shaping, volume and finishing detail, secured so it holds through a long event. It is priced by length, Medium or Long, and it sits above Updo (Classic) because it takes more time and skill. Talk to your stylist about your outfit, any accessories you plan to wear and the height or style of updo you have in mind. It suits weddings, receptions and formal events. Extra-long hair should be confirmed with the front desk before you book.",
  },
]

export const hairTreatments = [
  {
    name: "Straightening / Smoothening",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    variants: tri(SMLong, [7000, 9000, 11000], null),
    description:
      "A chemical straightening and smoothening service intended to leave hair straighter, smoother and easier to manage for an extended period, unlike heat styling that lasts only until the next wash. The process is carried out in stages by the stylist and takes into account your hair length and condition. Price is set by length, Small, Medium or Long, and no member rate is printed for this service. Because it is a longer, more involved treatment, please discuss your hair history, such as previous colour or chemical work, with the stylist first. The menu notes that advance treatments should be asked about at the front desk, and extra-long hair needs to be confirmed there too.",
  },
  {
    name: "Rebonding",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    variants: tri(SMLong, [8000, 10000, 12000], null),
    description:
      "Rebonding is a straightening treatment that reshapes the hair into a sleek, straight form, aimed at those who want a long-lasting straight look rather than a temporary styled finish. The stylist works through the hair in stages, so the service is priced by length: Small, Medium or Long. No member rate is printed on the menu for it. Since it is a significant chemical service, bring up any previous colouring, straightening or damage with your stylist before booking so they can advise whether it suits your hair. Aftercare advice is usually given at the salon. Please ask the front desk about advance treatments and about extra-long hair.",
  },
  {
    name: "Keratin",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    variants: tri(SMLong, [8000, 10000, 12000], null),
    description:
      "A keratin smoothing treatment that coats the hair with a protein-based formula to leave it smoother, shinier and noticeably less frizzy. It is the right choice if your main goal is manageability and shine, rather than the very straight result associated with rebonding. Price depends on length, Small, Medium or Long, and the menu lists no member rate. The stylist will assess your hair and talk you through aftercare, which usually includes how long to wait before washing and which products to use. An optional Add On Bond Strengthener is available with Keratin. For extra-long hair or advance treatments, the menu asks you to check with the front desk.",
  },
  {
    name: "Re-Growth / Partial Straightening",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    variants: tri(SHML, [5000, 6000, 7000], null),
    description:
      "A touch-up straightening service for hair that has already been straightened and now has new growth at the roots. Rather than treating the whole length again, the stylist straightens only the re-grown portion so the roots match the earlier straightened hair. Price is by length, Short, Medium or Long, with no member rate printed. Book this when your previous straightening is a few months old and the root area is starting to look different from the rest. If you are unsure whether a re-growth touch-up or a full treatment is right, ask the stylist, who can check the condition of your hair. Extra-long hair should be confirmed with the front desk.",
  },
  {
    name: "Add On Bond Strengthener (With Smoothening / Keratin)",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [850, null],
    description:
      "An add-on that can be booked together with a Smoothening or Keratin treatment, adding a bond-strengthening step to the visit. It is not a standalone service; it is meant to be paired with one of those chemical treatments, which is how the menu lists it. Customers who choose it generally do so because they want extra care for the hair while it goes through a smoothing treatment. Ask your stylist whether it is a good match for your hair type and history. It has no member rate on the menu. A separate add-on is offered for bond strengthening with hair colour, so choose the one that matches your main service.",
  },
  {
    name: "Botox",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [8000, null],
    description:
      "Hair Botox is a deep-conditioning style treatment offered at the salon, listed on the premium price list with no member rate. Treatments of this type are generally used to leave hair feeling softer, smoother and more polished, rather than to change its structure the way rebonding does. The printed menu gives only the name and price, so please ask your stylist to explain exactly what is applied and how it differs from Keratin or Smoothening for your hair type before you book. They can also tell you what aftercare to follow, such as how long to wait before the first wash after the treatment.",
  },
  {
    name: "Bond Treatment",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [4000, null],
    description:
      "Bond Treatment is a hair-repair service listed on the premium price list, aimed at hair that has been stressed by colouring, heat or chemical work. Bond treatments are generally designed to support the hair's internal structure so it feels stronger and more resilient. The menu does not break the service down further, so your stylist is the best person to explain what is used and how often it is suggested for your hair. It has no member rate. If you want bond care added to a colour or smoothening appointment, the menu also lists Add On Bond Strengthener options for those services, which may suit you better.",
  },
  {
    name: "Dandruff Treatment",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [2000, null],
    description:
      "Dandruff Treatment is a scalp-focused service from the salon's premium price list, aimed at flaking and an unsettled scalp. The treatment is carried out in the salon and works on the scalp rather than the lengths of the hair. The printed menu lists only the name and price, so please talk to your stylist about what is used and whether it suits your scalp, especially if your scalp is sensitive or irritated. For persistent or severe scalp problems, consult a doctor. The menu also offers an Anti Dandruff Treatment under the scalp treatments with a member rate, so compare the two with the front desk before choosing.",
  },
  {
    name: "Head Massage - Oil",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [650, 600],
    description:
      "A relaxing oil head massage that includes a hair wash. Warm oil is worked into the scalp and through the hair with steady massage movements across the head, neck and shoulders, which many people find helps them unwind after a long day. Because the hair wash is part of the service, you leave with the oil rinsed out and your hair clean. It is a popular pick for a break from a hectic week, and it also pairs well with a hair spa or haircut. Let the therapist know if you prefer lighter or firmer pressure, or if your scalp is sensitive.",
  },
  {
    name: "Moisturising Hair Spa",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [1000, 900],
    description:
      "A hair spa designed to put moisture back into dry, rough or dull-looking hair. The treatment typically involves cleansing, applying a moisturising mask or cream to the hair, and a relaxing scalp massage, leaving hair softer and easier to comb. It is a good fit if your hair feels dry after sun exposure, frequent washing, or heat styling. Because it focuses on hydration, it is the most general of the hair spa options on the menu; choose Color Save for coloured hair, Frizz Ease for frizz, or Repair & Rejuvenate for hair that needs extra care. Your stylist can help you choose between them based on your hair condition.",
  },
  {
    name: "Color Save",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [1100, 1000],
    description:
      "Color Save is a hair spa made for coloured hair. Its purpose is to look after hair that has been dyed, helping it keep a healthy, glossy appearance and supporting your colour between salon visits. The treatment is carried out as a spa-style service with cleansing and a nourishing mask. It is best booked after a colour service or whenever coloured hair begins to feel dry or look dull. Your stylist can advise on how often to repeat it and which at-home products pair well with it. If your hair is not coloured, the Moisturising Hair Spa or Frizz Ease may be a better fit.",
  },
  {
    name: "Frizz Ease",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [1100, 1000],
    description:
      "Frizz Ease is a hair spa aimed at frizzy, hard-to-manage hair. It is meant to leave the hair smoother and easier to control, with a softer feel and a more even look. The service follows a spa-style routine that cleanses the hair and applies a smoothing treatment, so you can expect your hair to be easier to style afterwards. It is a good option for humid weather, wavy or rough hair, or anyone who wants smoother hair without going for a chemical straightening treatment. For deeper, longer-lasting smoothing, ask about Keratin or Smoothening. Your stylist can suggest whichever suits your hair best.",
  },
  {
    name: "Repair & Rejuvenate",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [1200, 1100],
    description:
      "Repair & Rejuvenate is the hair spa for hair that has been through a lot, whether from colour, heat styling, chemical work or the weather. It is intended to leave hair feeling stronger, softer and more refreshed through a spa-style routine with cleansing, a nourishing mask and a scalp massage. It sits at the higher end of the menu's hair spa options because it is the one aimed at repair rather than simple moisture. It is a good choice if your hair feels brittle or looks tired. Ask your stylist whether this or one of the other spa treatments is the better match for your hair.",
  },
  {
    name: "Anti Hairfall Treatment",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [1600, 1500],
    description:
      "Anti Hairfall Treatment is a scalp treatment offered for people concerned about hair fall. It is carried out in the salon and focuses on the scalp and roots with a cleansing and nourishing routine, along with a massage. The treatment supports scalp care but does not promise to stop or reverse hair loss, which can have many causes. If you are worried about the amount of hair you are losing, it is wise to speak to a doctor as well. Your stylist can discuss how often the treatment is typically repeated and suggest at-home care to go with it.",
  },
  {
    name: "Anti Dandruff Treatment",
    category: "HAIR TREATMENTS",
    audience: "UNISEX",
    price: [1600, 1500],
    description:
      "Anti Dandruff Treatment is a scalp treatment designed for flaking and dandruff. It is done in the salon and concentrates on cleansing the scalp, followed by a soothing routine to leave it feeling fresh and comfortable. It is appropriate when you notice recurring flakes or an itchy, unsettled scalp, but it is a cosmetic care service rather than medical treatment. Persistent or severe scalp conditions should be seen by a doctor. Your stylist can suggest a shampoo routine to use between visits. A separate Dandruff Treatment also appears on the salon's premium price list, so ask the front desk if you are unsure which to choose.",
  },
]

export const colour = [
  {
    name: "Premium Color",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    price: [1000, 900],
    description:
      "Premium Color is listed on the menu under grey coverage and is the salon's standard colouring service for covering greys. A professional colour is applied and left to develop, then rinsed, so grey strands blend in with the rest of your hair. It uses a regular formula that includes ammonia; if you prefer an ammonia-free option, choose Premium Color Ammonia Free instead. The price listed is for this service as printed, and for roots only you may prefer the Root Touch Up service. Tell your stylist about your natural shade, any previous colour and any sensitivity you have so they can choose the right tone for you.",
  },
  {
    name: "Premium Color Ammonia Free",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    price: [1200, 1100],
    description:
      "Premium Color Ammonia Free is a grey-coverage colouring service that uses an ammonia-free colour, which many people prefer for its gentler smell. It follows the same approach as Premium Color: a professional colour is applied, developed and rinsed so grey hair blends in. It costs a little more than the regular formula. Choose it if you are sensitive to the smell of ammonia-based dyes or simply prefer this type of colour. It is not a promise of no reaction, so tell your stylist about any past sensitivity or allergies before the service. For roots only, ask about Root Touch Up Ammonia Free.",
  },
  {
    name: "Fashion Color",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    price: [2000, 1800],
    description:
      "Fashion Color is for people who want colour as a style statement rather than just grey coverage, using bolder, trend-led shades such as vivid reds, plums, blues or other fashion tones. The stylist will discuss which shade works with your starting colour and skin tone, because fashion shades often need lightening first and can look different on dark or previously coloured hair. The listed price is for the service as printed on the menu; larger areas of colour are covered by the Global Fashion Colour services, where prices depend on length. Bring reference pictures if you have a shade in mind.",
  },
  {
    name: "Creative Coloring",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    variants: [
      ["Small", 2500, 2300],
      ["Medium", 3000, 2800],
    ],
    description:
      "Creative Coloring is a freehand colouring service in which the stylist places colour in chosen sections, creating contrast, accents or colour blocking instead of applying one shade all over. It is sold by size, Small or Medium, which relates to how much of the hair is coloured. It suits customers who want something more expressive than a single solid colour but not a full global colour. Discuss the colours and placement you want, and the stylist will advise what is realistic for your hair. For colouring the whole head in creative shades, the Full Streaking / Creative Colour service lists prices by hair length.",
  },
  {
    name: "Streak",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    variants: [
      ["Small", 300, null],
      ["Medium", 400, null],
    ],
    description:
      "Streak is a per-streak colouring service: individual strands or sections are coloured to add a highlight or contrast, and you pay per streak, with a minimum of three streaks per booking. The size, Small or Medium, refers to the size of each streak. It is ideal for adding a few touches of colour near the face or through the hair without colouring the entire head. Choose how many streaks and where you want them with the stylist. There is no member rate for this service. A similar service called Hair Streaking is also on the menu with Small, Medium and Large sizes and different prices, so ask which suits you.",
  },
  {
    name: "Root Touch Up Ammonia (1 inch)",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    price: [1000, 900],
    description:
      "Root Touch Up Ammonia is a colouring service for new growth, where colour is applied only to the first inch of hair at the roots to cover regrowth and greys that have appeared since your last colour. It uses an ammonia-based colour. It is quicker and costs less than colouring the full length, and it works best when the rest of your hair still has fresh colour. The price is based on one inch of regrowth, so tell the stylist if your roots are longer than that. If you prefer a gentler-smelling formula, choose the ammonia-free version of this service instead.",
  },
  {
    name: "Root Touch Up Ammonia Free (1 inch)",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    price: [1300, 1200],
    description:
      "Root Touch Up Ammonia Free covers new growth at the roots, up to one inch, using an ammonia-free colour. It is for customers whose colour is still fresh through the lengths but whose roots or greys are starting to show. Because only the roots are coloured, it is a quicker and lighter alternative to a full colour. People who dislike the smell of ammonia-based dye often prefer this option. The price is set for one inch of regrowth, so let the stylist know if you have more than that. Please mention any sensitivity or past reaction to hair colour before the service begins.",
  },
  {
    name: "Global Colour",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    variants: tri(SHML, [3000, 3200, 3500], [2900, 3100, 3400]),
    description:
      "Global Colour is a single-shade colour applied all over the hair, from roots to ends, for an even, uniform result. It is the standard choice for a full colour change or for refreshing your whole colour. The price depends on hair length, Short, Medium or Long. The stylist will help you choose a shade that suits your skin tone and starting colour. This option uses a regular formula; variants with fashion shades, ammonia-free colour or highlights are listed separately. The menu notes that extra-long hair needs to be confirmed with the front desk.",
  },
  {
    name: "Global Fashion Colour",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    variants: tri(SHML, [3500, 4000, 4500], [3400, 3900, 4400]),
    description:
      "Global Fashion Colour applies a fashion shade across the whole head, for a bold all-over look in tones that go beyond natural browns and blacks. The price is by length, Short, Medium or Long. Fashion shades can need extra preparation depending on your starting colour, so the stylist will check your hair and explain what is possible in one visit. It costs more than a regular Global Colour because of the shades and technique involved. Take reference pictures along if you have a colour in mind, and ask about at-home care to help your colour last. Extra-long hair should be confirmed with the front desk.",
  },
  {
    name: "Global Ammonia Free Colour",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    variants: tri(SHML, [3200, 3500, 3800], [3100, 3400, 3700]),
    description:
      "Global Ammonia Free Colour colours the whole head in a single shade using an ammonia-free formula. It is aimed at people who like an even all-over colour but prefer a colour without the strong smell associated with ammonia. Pricing is by hair length: Short, Medium or Long. The stylist will advise on shade selection and what result you can expect from your starting colour. Mention any past sensitivity to colour before the service. The menu notes that extra-long hair should be confirmed with the front desk, since it can affect product use and price.",
  },
  {
    name: "Global Fashion Colour Ammonia Free",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    variants: tri(SHML, [3800, 4000, 4200], [3700, 3900, 4100]),
    description:
      "Global Fashion Colour Ammonia Free combines two things on this menu: an all-over fashion shade and an ammonia-free formula. It is for customers who want a bold, trend-led colour across the whole head but would rather use an ammonia-free product. Prices are set by length, Short, Medium or Long. Your stylist will assess your starting colour and explain how the shade is likely to turn out and how many visits it may take. Bring pictures of the look you want. The menu asks you to check with the front desk for extra-long hair.",
  },
  {
    name: "Global Colour + Highlights",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    variants: tri(SHML, [5000, 5500, 6000], [4900, 5400, 5900]),
    description:
      "Global Colour + Highlights combines an all-over base colour with highlights, creating depth and dimension rather than a flat single shade. The base colour is applied first, then lighter sections are added in chosen areas. Pricing is by length, Short, Medium or Long, and it costs more than a Global Colour alone because of the additional highlighting step. Talk with the stylist about how subtle or contrasting you want the highlights and which tones will suit your skin. Because it is a longer, multi-step service, plan for a longer appointment. Extra-long hair should be confirmed with the front desk.",
  },
  {
    name: "Full Streaking / Creative Colour",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    variants: tri(SHML, [5000, 6000, 7000], [4800, 5800, 6800]),
    description:
      "Full Streaking / Creative Colour is a head-wide colouring service in which streaks and creative colour placement are worked through the entire head, not just a few accents. It suits customers who want a dramatic, multi-tone look. The price depends on length, Short, Medium or Long. The stylist will plan colours and placement with you, and will advise on how realistic the look is for your starting colour. It is a long service, so allow extra time. For adding just a few individual streaks, see the Streak or Hair Streaking services. Extra-long hair should be confirmed with the front desk.",
  },
  {
    name: "Hair Streaking",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    variants: tri(SML, [400, 500, 600], [350, 450, 550]),
    description:
      "Hair Streaking is a per-streak service, priced for each streak with a minimum of three streaks. You choose a size for each streak, Small, Medium or Large, depending on how thick a section of hair you want coloured. It adds highlights or colour accents without colouring the whole head, so it is a good low-commitment way to try a new colour. Decide with the stylist how many streaks you want and where to put them, such as around the face or underneath layers. A separate service named Streak is also listed on the menu with different prices, so check with the front desk about which fits your plan.",
  },
  {
    name: "Add On Bond Strengthener (With Hair Color)",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    price: [600, null],
    description:
      "An add-on to be booked together with a hair colour service. A bond-strengthening step is included alongside the colour, intended to help look after the hair while it goes through colouring. It is not sold on its own; the menu lists it as an addition to your colour appointment. It carries no member rate. Consider it if your hair is already fragile, has been coloured several times, or if you are going lighter. Ask your stylist whether it is worthwhile for your hair type. A separate bond strengthener add-on exists for Smoothening and Keratin treatments, so choose the one that matches your main service.",
  },
  {
    name: "Hair Color",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    price: [5000, null],
    description:
      "Hair Color is listed on the salon's premium price list as a full colour service with no member rate. The printed menu gives only the name and price and does not detail the formula or length bands, which are covered in the Global Colour services with prices by length. Your stylist can explain what this premium listing includes and how it compares with the other colour options before you book. Share your natural shade, any colour history and the result you are after, so the right shade and technique can be chosen. Mention any allergies or sensitivity to colour before the service starts.",
  },
  {
    name: "Hair Touch Up",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    price: [2000, null],
    description:
      "Hair Touch Up is a colour refresh listed on the salon's premium price list, with no member rate. It is intended for hair that has already been coloured and needs the colour renewed, typically at the roots as new growth appears. The printed menu does not specify the area covered or the colour type, so please ask your stylist or the front desk what this listing includes. Root-only services on the main colour pages, Root Touch Up Ammonia and Root Touch Up Ammonia Free, are priced per inch of regrowth, and you may wish to compare them. Mention any previous sensitivity to hair colour.",
  },
  {
    name: "Balayage Hair Color",
    category: "HAIR COLOUR",
    audience: "UNISEX",
    price: [9000, null],
    description:
      "Balayage is a freehand technique in which colour is painted onto the hair by hand, creating a soft, graduated, sun-kissed effect that grows out gently without a harsh line at the roots. It is listed on the premium price list as Balayage Hair Color and has no member rate. Because each section is painted individually, it is a long, detailed service that depends on your starting colour, length and the level of lightness you want. Your stylist will go through the shades and may suggest a toner or care routine to keep the colour looking good. Bring reference photos of the look you want.",
  },
]
