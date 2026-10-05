// Nails, body treatments, reflexology, makeup, bridal, mehendi, kids and men's grooming.
// Prices exact from the printed menu; null member = "NA".

const mani = (name, reg, mem, description) => ({ name, category: "NAILS", audience: "UNISEX", price: [reg, mem], description })

export const nails = [
  mani(
    "Cocoa Butter Manicure", 700, 650,
    "Cocoa Butter Manicure is a hand and nail care service built around a rich cocoa butter treatment. Nails are shaped and filed, cuticles are tidied, and the hands are cleansed, massaged and moisturised, leaving them soft and well groomed. It is the most affordable manicure on the menu, so it makes a good everyday or pre-event option. Tell the therapist about any cuts, nail conditions or allergies before the service begins, and mention the nail shape you prefer. Nail polish is not included in the listed price, so add Change of Nail Polish or another polish service if you want colour."
  ),
  mani(
    "Cocoa Butter Pedicure", 900, 850,
    "Cocoa Butter Pedicure is a foot care service using a cocoa butter treatment. Feet are soaked and cleansed, nails are trimmed and shaped, cuticles are tidied, rough skin is smoothed, and a massage with moisturiser finishes the service. It suits anyone who wants neat, comfortable feet at an affordable price, and it is a good starting point among the pedicure options. Let the therapist know about cracked skin, cuts, diabetes or any foot condition beforehand. Polish is not included in the listed price; add Change of Nail Polish or another polish service for colour."
  ),
  mani(
    "Coffee & Creme Manicure", 800, 750,
    "Coffee & Creme Manicure is a hand and nail service that uses a coffee and cream themed treatment. Your nails are shaped and filed, cuticles are tidied, and the hands are cleansed, gently exfoliated and massaged with a moisturising cream. It is one step above the Cocoa Butter manicure on the menu and leaves the hands soft and neat. Tell the therapist about nail conditions, cuts or allergies before it begins, and mention your preferred nail shape. Polish is not included in the listed price; Change of Nail Polish or other polish services can be added."
  ),
  mani(
    "Coffee & Creme Pedicure", 1000, 900,
    "Coffee & Creme Pedicure is a foot care service built around a coffee and cream themed treatment. Feet are soaked and cleansed, nails are trimmed and shaped, rough areas are smoothed, and a massage with cream completes the service. It suits those who want something a little more indulgent than the basic Cocoa Butter pedicure. Tell the therapist about any foot conditions, cuts, diabetes or allergies before starting. The listed price does not include polish, so book Change of Nail Polish or another polish service if you want colour on your toes."
  ),
  mani(
    "Dead Sea Manicure", 900, 850,
    "Dead Sea Manicure is a hand and nail service that features Dead Sea minerals in the treatment. Nails are shaped and filed, cuticles tidied, and the hands are cleansed, exfoliated and massaged, leaving them feeling soft and refreshed. It sits in the middle of the manicure range on the menu. Mention any nail conditions, cuts or allergies to the therapist before the service starts, along with the nail shape you like. Polish is not included in the listed price, so choose Change of Nail Polish or another polish option if you want colour."
  ),
  mani(
    "Dead Sea Pedicure", 1100, 1000,
    "Dead Sea Pedicure is a foot care service with Dead Sea minerals included in the treatment. Feet are soaked and cleansed, nails trimmed and shaped, rough skin is smoothed, and the feet are massaged with a moisturiser. It is a good choice if you want a mineral-themed, relaxing foot service. Let the therapist know about cracked skin, cuts, diabetes or any foot condition beforehand. The price does not include polish, so add Change of Nail Polish or another polish service if you would like colour on your toes."
  ),
  mani(
    "Organic Spa Manicure", 1000, 950,
    "Organic Spa Manicure is a spa-style hand and nail service. Nails are shaped and filed, cuticles are tidied, and the hands are cleansed, exfoliated and given a relaxing massage with a moisturising treatment, leaving them soft and polished. It sits above the Dead Sea manicure on the menu and is a pleasant choice when you want a bit more pampering. Tell the therapist about any nail conditions, cuts or allergies before it starts. Polish is not included in the listed price; you can add Change of Nail Polish or another polish service."
  ),
  mani(
    "Organic Spa Pedicure", 1200, 1150,
    "Organic Spa Pedicure is a spa-style foot care service. Feet are soaked and cleansed, nails trimmed and shaped, rough skin smoothed, and the service finishes with a relaxing massage and moisturiser. It is a step up from the Dead Sea pedicure and is well suited to a more indulgent, relaxing session. Tell the therapist about cracked skin, cuts, diabetes or other foot conditions beforehand. Polish is not included in the listed price, so add Change of Nail Polish or another polish service if you want colour on your toes."
  ),
  mani(
    "Crystal Spa Manicure", 1100, 1000,
    "Crystal Spa Manicure is a premium spa hand and nail service. Nails are shaped and filed, cuticles are tidied, and the hands are cleansed, exfoliated and massaged with a spa treatment, finishing with moisturiser for soft, groomed hands. It sits in the upper part of the manicure range. On the newer menu page the manicure and pedicure prices for this treatment appear in swapped order, so the manicure price here follows the older page and the logical order. Tell the therapist about nail conditions, cuts or allergies before it begins; polish is extra."
  ),
  mani(
    "Crystal Spa Pedicure", 1400, 1300,
    "Crystal Spa Pedicure is a premium spa foot service. Feet are soaked and cleansed, nails trimmed and shaped, rough skin smoothed, and a long, relaxing massage with a spa treatment and moisturiser finishes the service. It is one of the higher priced pedicures on the menu. On the newer menu page the manicure and pedicure prices for this treatment appear in swapped order, so the pedicure price here follows the older page and the logical order. Tell the therapist about foot conditions, cuts or diabetes beforehand; polish is extra."
  ),
  mani(
    "Ice Cream Manicure", 1300, 1200,
    "Ice Cream Manicure is the most indulgent manicure on the menu, a pampering hand and nail service with a dessert-themed treatment. Nails are shaped and filed, cuticles are tidied, and the hands are cleansed, exfoliated, massaged and moisturised, leaving them soft and beautifully groomed. It is a good treat before a special occasion or simply when you want a more luxurious session. Tell the therapist about nail conditions, cuts or allergies before the service begins. Polish is not included in the listed price; add Change of Nail Polish or another polish service."
  ),
  mani(
    "Ice Cream Pedicure", 1600, 1500,
    "Ice Cream Pedicure is the most indulgent pedicure on the menu, a pampering foot service with a dessert-themed treatment. Feet are soaked and cleansed, nails trimmed and shaped, rough skin is smoothed, and a long massage with a moisturising treatment finishes the session. It is an ideal treat for tired feet, before a holiday or special event. Tell the therapist about cracked skin, cuts, diabetes or any foot condition beforehand. Polish is not included in the listed price; add Change of Nail Polish or another polish service if you want colour."
  ),
  {
    name: "Pedicure (Gents & Ladies Both)",
    category: "NAILS",
    audience: "UNISEX",
    variants: [
      ["Normal", 1500, null],
      ["Luxury", 2000, null],
      ["Hill", 3000, null],
    ],
    description:
      "This pedicure comes from the menu page headed Gents & Ladies Both, so it is offered to men and women alike. Three levels are listed: Normal, Luxury and Hill, rising in price and presumably in the level of care. The printed menu does not explain what each level includes, so ask the therapist before booking if you want to know the differences. A pedicure generally covers soaking and cleansing the feet, trimming and shaping nails, smoothing rough skin and a massage. Tell the therapist about foot conditions, cuts or diabetes beforehand. No member rate is printed.",
  },
  {
    name: "Minicure (Gents & Ladies Both)",
    category: "NAILS",
    audience: "UNISEX",
    variants: [
      ["Normal", 1500, null],
      ["Luxury", 2000, null],
      ["Hill", 3000, null],
    ],
    description:
      "Minicure is the name printed on the menu page headed Gents & Ladies Both, so it is offered to both men and women. It appears alongside the pedicure options with the same three levels: Normal, Luxury and Hill, at the same prices. The printed menu does not define the word Minicure or say what each level includes, so please confirm with the therapist or front desk what is done at each level before you book. Tell the therapist about nail conditions, cuts or allergies before the service starts. No member rate is printed for this service.",
  },
  mani(
    "Change of Nail Polish", 200, 180,
    "Change of Nail Polish is a quick service in which your existing nail polish is removed and fresh polish is applied. It suits customers who have already had their nails shaped and cared for and only want a new colour, for instance before an outing or event. It is often added to a manicure or pedicure, since those services do not include polish in their listed price. Choose your colour from the salon's range, and let the therapist know if you have sensitive nails or any nail condition. Allow the polish a few minutes to dry fully before leaving to avoid smudging."
  ),
  mani(
    "Cut & File", 150, 120,
    "Cut & File is a basic nail grooming service in which nails are trimmed to the length you want and filed into a neat shape, such as round, oval or square. It does not include the soaking, cleansing and massage of a full manicure or pedicure, so it is the quickest and most economical way to tidy hands or feet. It is a good option between longer treatments or when you are short of time. Tell the therapist your preferred length and shape, and mention any nail condition, cut or allergy before the service starts."
  ),
  {
    name: "French Polish (Fingers / Toes)",
    category: "NAILS",
    audience: "UNISEX",
    price: [400, null],
    description:
      "French Polish is a classic nail finish with a pale or natural base and a clean white tip, giving a timeless, polished look. The service is listed for fingers or toes, and the menu shows a single price for it with no member rate. Your therapist will prepare the nail surface and apply the base and tip colour with a steady hand. It goes well with a manicure or pedicure and suits formal occasions, weddings and everyday wear. Allow time for the polish to dry fully before leaving. Mention any nail condition or allergy before the service begins.",
  },
  {
    name: "Nail Art",
    category: "NAILS",
    audience: "UNISEX",
    variants: [
      ["Fingers", 500, null],
      ["Toes", 700, null],
    ],
    description:
      "Nail Art is a decorative nail service in which designs are painted or applied to the nails, from simple patterns to more detailed artwork. It is offered for fingers or toes, priced separately, with no member rate. Tell the therapist the design, colours and style you have in mind, and bring a picture if you can, so they can tell you what is realistic. Nail art is usually done on top of polish, so you may want to combine it with a manicure, pedicure or polish change. Mention any nail condition or allergy before the service begins.",
  },
  {
    name: "Gel Polish (Fingers / Toes)",
    category: "NAILS",
    audience: "UNISEX",
    price: [1000, null],
    description:
      "Gel Polish is a long-lasting nail finish that is cured under a lamp, so it dries instantly and stays glossy and chip-resistant for longer than ordinary polish. The menu lists it for fingers or toes with a single price and no member rate. Your therapist will prepare the nails, apply the gel colour in layers and cure each layer. Gel polish needs to be removed properly rather than peeled off, and a separate Removal of Gel Polish service is available. Tell the therapist about any nail condition or allergy to gel products before the service starts.",
  },
  {
    name: "Removal of Gel Polish",
    category: "NAILS",
    audience: "UNISEX",
    price: [500, null],
    description:
      "Removal of Gel Polish is a professional removal service for gel polish, so that it is taken off safely rather than being peeled or scraped off, which can damage the nail surface. The gel is softened and gently removed, and the nails are left clean and ready for fresh polish or a rest from colour. It has no member rate on the menu. Book it when your gel polish has grown out or started to lift, and combine it with a new Gel Polish service or a manicure if you wish. Let the therapist know about any nail sensitivity or damage before the service begins.",
  },
  {
    name: "Heel Peel",
    category: "NAILS",
    audience: "UNISEX",
    price: [2500, null],
    description:
      "Heel Peel is a foot treatment listed on the menu under treatment, with no member rate. It targets the heels, where rough, hard or cracked-looking skin tends to build up, with a specialised peeling treatment to leave the area looking smoother. The menu gives no further detail on the method, so ask the therapist what is used and how many sessions are generally advised. It is a cosmetic foot treatment and not a medical one. Tell the therapist if you have diabetes, open cracks, wounds or any foot condition before booking, since these may need a doctor's advice first.",
  },
]

export const bodyTreatments = [
  {
    name: "Cocoa Butter Therapy",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [2500, null],
    description:
      "Cocoa Butter Therapy is a full relaxation massage using cocoa butter, which is warmed and worked into the body to leave the skin soft and nourished. The menu spells it Cocoa Butter Theropy and lists it with no member rate. It is a way to unwind after a stressful week, and the cocoa butter gives the skin a smooth, moisturised finish. Tell the therapist about the pressure you prefer, any areas to avoid, and any allergies or skin sensitivities, particularly to cocoa or nut-related products. Avoid heavy meals just before the session and drink water afterwards.",
  },
  {
    name: "Aroma Oil Therapy",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [2500, null],
    description:
      "Aroma Oil Therapy is a relaxing body massage that uses aromatic oils to soothe the senses while the muscles are worked on. The menu spells it Aroma Oil Theropy and lists it with no member rate. The fragrance of the oils is part of the experience, so tell the therapist if you are sensitive to scents or have any allergies. It is a good choice for relaxing and unwinding, and for anyone who prefers a scented massage over an unscented one. Mention pressure preference and any areas to avoid, and drink water after the session.",
  },
  {
    name: "Back Polish",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [1800, null],
    description:
      "Back Polish is a multi-step treatment for the back that combines D-Tan, polish, a mask and therapy, as the menu lists. D-Tan lifts surface tan, a polish exfoliates and smooths the skin, a mask nourishes, and the therapy step is a relaxing massage to finish. It leaves the back looking and feeling smoother, and it is popular before backless outfits or weddings. The service has no member rate. Tell the therapist about sensitive skin, sunburn, breakouts or allergies on the back before starting, as these can affect which products are suitable.",
  },
  {
    name: "Hand Polish (FA + UA)",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [2000, null],
    description:
      "Hand Polish is a treatment for the full arms (FA) and underarms (UA), made up of D-Tan, polish, a wrap and therapy, as listed on the menu. D-Tan lifts surface tan, the polish exfoliates, the wrap nourishes the skin, and the therapy step is a relaxing massage. The aim is smoother, brighter-looking arms. It has no member rate. Tell the therapist about sensitive skin, sunburn, recent waxing or any allergies before starting, as these affect which products can be used safely. Moisturise well afterwards and follow the therapist's advice on sun protection.",
  },
  {
    name: "Full Legs Polish",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [2500, null],
    description:
      "Full Legs Polish is a treatment for the entire legs, including D-Tan, polish, a wrap and therapy, as listed on the menu. D-Tan lifts surface tan, the polish exfoliates and smooths, the wrap nourishes the skin, and the therapy step is a relaxing massage. It leaves the legs looking smoother and more even. It has no member rate. Because it covers a large area, allow plenty of time. Tell the therapist about sensitive skin, varicose veins, sunburn, recent waxing or allergies before starting. Wear loose clothing to the appointment and drink water afterwards.",
  },
  {
    name: "Half Legs Polish",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [1800, null],
    description:
      "Half Legs Polish is the shorter version of the leg polish treatment, covering half the legs with D-Tan, polish, a wrap and therapy, as listed on the menu. D-Tan lifts surface tan, the polish exfoliates and smooths, the wrap nourishes, and the therapy is a relaxing massage to finish. It is a good option if you want smoother lower legs without the full-leg service. It has no member rate. Tell the therapist about sensitive skin, sunburn, recent waxing or any allergies before starting, so the products can be chosen safely.",
  },
  {
    name: "Body Polish",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [2500, null],
    description:
      "Body Polish is a full-body exfoliating treatment in which the skin is scrubbed with a polishing product to remove dead surface cells, leaving it smoother and softer to the touch. It is often chosen before weddings, holidays or special events, or as a seasonal treat. The menu lists it with no member rate and no further detail, so ask the therapist what products are used. Tell them about sensitive skin, sunburn, skin conditions, recent waxing or allergies before the treatment starts. Moisturise well afterwards and avoid harsh products on the same day.",
  },
  {
    name: "Body Wrap",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [2500, null],
    description:
      "Body Wrap is a spa treatment in which a nourishing product is applied to the body and the body is wrapped, allowing the product to work while you relax. The menu lists it as Body Wrap on the newer page and Body Warp on the older one, at the same price and with no member rate. It leaves the skin feeling soft and pampered. Ask the therapist what products are used, and tell them about allergies, skin sensitivity, pregnancy or any health condition before the treatment starts. Drink water after the session and moisturise as advised.",
  },
  {
    name: "Body D-Tan",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [3300, null],
    description:
      "Body D-Tan is a full-body treatment designed to remove surface tan and even out the look of the skin on areas exposed to the sun. It is helpful after a holiday or an outdoor season, or before an event when you want your skin tone to look more uniform. The menu lists it with no member rate. Results are cosmetic and depend on your skin and how deep the tan is. Tell the therapist about sensitive skin, sunburn, skin conditions or allergies before the treatment starts, and follow their advice on sun protection afterwards.",
  },
  {
    name: "D-Tan + Polish + Wrap + Therapy",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [8000, null],
    description:
      "This is the salon's complete body package, combining a D-Tan treatment, a body polish, a nourishing wrap and a relaxing therapy session in one visit. D-Tan lifts surface tan, the polish exfoliates and smooths, the wrap nourishes the skin, and the therapy is a massage to finish. It is the most comprehensive body option on the menu and has no member rate. Because it is a multi-step, long session, allow plenty of time. Tell the therapist about sensitive skin, skin conditions, sunburn, allergies or any health concern before starting.",
  },
  {
    name: "Polish + Wrap + Therapy",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [6000, null],
    description:
      "Polish + Wrap + Therapy is a three-step body package listed on the older menu page, combining a body polish, a nourishing wrap and a relaxing therapy session, without the D-Tan step included in the complete package. The polish exfoliates and smooths, the wrap nourishes the skin and the therapy is a massage to finish. It is the more affordable of the two packages and has no member rate. Tell the therapist about sensitive skin, skin conditions, allergies or any health concern before starting, and drink water afterwards.",
  },
  {
    name: "Back Facial",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [2200, null],
    description:
      "Back Facial is a facial-style treatment for the back, with the same kind of steps you would have on the face: cleansing, exfoliation, a mask and massage. It is a good choice if you want clean, smooth-looking skin on your back, for example before backless clothing or a special event. The menu lists it with no member rate. Tell the therapist about sensitive skin, breakouts, sunburn or allergies before the treatment starts, so that the products and pressure suit your skin. Moisturise afterwards and avoid harsh products or heavy sweating for the rest of the day.",
  },
  {
    name: "Steam Bath",
    category: "BODY TREATMENTS",
    audience: "UNISEX",
    price: [500, null],
    description:
      "Steam Bath is a heat-based relaxation service in which you sit in warm steam, which many people find helps them unwind and leaves them feeling refreshed. The menu lists it with no member rate. It is often combined with body massage, polish or wrap treatments. Because steam raises body temperature, tell the staff beforehand if you have a heart condition, low or high blood pressure, are pregnant, feel unwell, or have any health concern. Drink water before and after, and stop the session if you feel dizzy or uncomfortable.",
  },
]

export const reflexology = [
  {
    name: "Reflexology",
    category: "REFLEXOLOGY",
    audience: "UNISEX",
    variants: [
      ["Neck & Shoulder", 800, null],
      ["Hand", 500, null],
      ["Feet", 700, null],
    ],
    description:
      "Reflexology is a pressure-based massage focused on one part of the body. Choose Neck & Shoulder for the tension that builds up from desk work and stress, Hand for tired hands, or Feet for a classic foot reflexology session. The therapist applies firm, rhythmic pressure to specific points, and many customers find it a relaxing break in the day. The menu lists it with no member rate. Tell the therapist about the pressure you prefer, any injuries, pain or conditions in the area, and whether you are pregnant. It is a relaxation service and not a medical treatment.",
  },
]

export const makeup = [
  {
    name: "Kryolan Makeup",
    category: "MAKEUP",
    audience: "MEN",
    price: [6000, null],
    description:
      "Kryolan Makeup is listed under Groom Makeup and combines makeup, a shave and a hair style in a single package, so the whole look is prepared in one visit. Kryolan is the professional makeup brand used for the makeup portion. It is designed for the groom on the wedding day or for a special event or shoot where a polished, camera-ready appearance matters. There is no member rate. Discuss the look you want with the artist beforehand, tell them about skin sensitivities or allergies, and bring reference pictures if you have them.",
  },
  {
    name: "MAC Makeup",
    category: "MAKEUP",
    audience: "MEN",
    price: [8000, null],
    description:
      "MAC Makeup is listed under Groom Makeup and combines makeup, a shave and a hair style in a single package, so that the whole look is completed in one visit. MAC is the professional makeup brand used for the makeup portion, and this package costs more than the Kryolan option. It is meant for the groom on the wedding day or for any special occasion where a polished appearance is needed. There is no member rate. Tell the artist about skin sensitivities or allergies in advance, and share reference pictures of the look you want.",
  },
  {
    name: "Light Makeup (HD Makeup)",
    category: "MAKEUP",
    audience: "UNISEX",
    price: [2500, null],
    description:
      "Light Makeup is listed under the HD Makeup heading and is the lightest option in that group, a soft, natural application suited to parties, festive days or dinners. HD makeup is designed to look smooth in high-definition photographs and video. This is different from the Bridal Makeup 'Light Makeup' package, which has its own price on the bridal page. There is no member rate. Tell the artist about your skin type, any allergies and the outfit you are wearing, so that the shades and finish can be matched to you.",
  },
  {
    name: "HD Light Makeup",
    category: "MAKEUP",
    audience: "UNISEX",
    price: [4500, null],
    description:
      "HD Light Makeup is listed under the HD Makeup heading as the next step up from the lighter option. HD makeup is applied with products that look smooth and natural in high-definition photography and video, and this version offers a refined light finish for events, receptions and parties. There is no member rate. Discuss the look you want with the artist, mention your skin type and any allergies, and share the outfit and event details so that the shades and intensity can be matched. Bring reference photos if you have them.",
  },
  {
    name: "Bright Makeup",
    category: "MAKEUP",
    audience: "UNISEX",
    variants: [
      ["Medium", 10000, null],
      ["Long", 15000, null],
    ],
    description:
      "Bright Makeup is listed under the HD Makeup heading as the fuller, more dramatic look in that group, above the Light and HD Light options. The menu prints two prices for it, and the option you choose here is Medium or Long, depending on how much work the look needs. HD makeup is applied with products that look smooth and natural in high-definition photographs and video, which makes this a good fit for receptions, shoots and large celebrations. There is no member rate. Tell the artist about your skin type, any allergies and your outfit, and bring reference pictures so the shades and intensity can be matched to you.",
  },
]

export const bridal = [
  {
    name: "Light Makeup (Bridal)",
    category: "BRIDAL MAKEUP",
    audience: "WOMEN",
    price: [5000, null],
    description:
      "Light Makeup is the entry-level package on the bridal makeup page, offering a soft, natural makeup look for the bride. It is designed for brides who prefer a fresh, understated appearance for their ceremony, engagement or reception. It is priced separately from the Light Makeup under the HD Makeup heading. There is no member rate. Book a trial first if you want to be sure of the look, and tell the artist about your skin type, any allergies, your outfit and the venue lighting so the shades and finish suit you on the day.",
  },
  {
    name: "Shining Star - Kryolan",
    category: "BRIDAL MAKEUP",
    audience: "WOMEN",
    price: [8000, null],
    description:
      "Shining Star is the Kryolan bridal makeup package, using Kryolan professional products to create a polished, long-wearing bridal look. Kryolan is known among makeup artists for its coverage and finish, which makes it a popular choice for weddings and photographs. There is no member rate. Discuss your outfit, jewellery and the look you want with the artist, and consider booking a Kryolan trial beforehand. Tell the artist about your skin type, allergies and any products that have irritated your skin in the past.",
  },
  {
    name: "Naturally Georgeous - MAC",
    category: "BRIDAL MAKEUP",
    audience: "WOMEN",
    price: [12000, null],
    description:
      "Naturally Georgeous is the MAC bridal makeup package, using MAC professional products for a refined, camera-friendly bridal look. The name is printed as Naturally Georgeous on the menu and is kept as written. MAC is widely used by professional artists, and this package sits above the Kryolan option in price. There is no member rate. Discuss your outfit, jewellery and desired finish with the artist, and consider booking a MAC trial beforehand. Tell the artist about your skin type, allergies and any products that have irritated your skin before.",
  },
  {
    name: "Picture Perfect (HD / Air Brush)",
    category: "BRIDAL MAKEUP",
    audience: "WOMEN",
    price: [20000, null],
    description:
      "Picture Perfect is the salon's premium bridal makeup package, using HD or air brush techniques for a flawless finish that holds up in close-up photographs and video. Air brush makeup is applied as a fine spray for an even, lightweight look, while HD makeup is formulated to appear smooth on camera. It is the highest priced bridal makeup option and has no member rate. Discuss the finish you want with the artist, book a trial if possible, and share your skin type, allergies and the venue's lighting conditions so that the look suits your wedding day.",
  },
  {
    name: "Hair Do",
    category: "BRIDAL MAKEUP",
    audience: "WOMEN",
    variants: [
      ["Classic - Medium", 1500, null],
      ["Classic - Long", 2000, null],
      ["Elite - Medium", 2000, null],
      ["Elite - Long", 2500, null],
    ],
    description:
      "Hair Do is the bridal hairstyling service on the bridal page, offered in two styles, Classic and Elite, and priced by hair length, Medium or Long. Classic is the simpler, traditional bridal style, while Elite is the more elaborate option with extra detailing, and it costs more. Choose the style first and then the length that matches your hair. The stylist will build the look around your outfit, jewellery, dupatta or veil, and the way you want your hair to sit through the ceremony. There is no member rate. Bring pictures of the style you like and any hair accessories you plan to wear, and tell the stylist about scalp sensitivity or recent hair treatments.",
  },
  {
    name: "Saree Drape",
    category: "BRIDAL MAKEUP",
    audience: "WOMEN",
    variants: [
      ["Classic", 750, null],
      ["Elite", 1000, null],
    ],
    description:
      "Saree Drape is a professional saree draping service, so your saree is pleated and pinned neatly and stays comfortable through the event. Two levels are offered: Classic, a traditional neat drape, and Elite, the premium option for a more refined finish. The menu prints the name as Saree Drap. It is popular for weddings, receptions and festive functions, often booked with makeup and hair. There is no member rate. Bring the saree, blouse, petticoat and pins you plan to wear, and tell the stylist about the drape style you prefer.",
  },
  {
    name: "Family & Friends Makeup",
    category: "BRIDAL MAKEUP",
    audience: "UNISEX",
    price: [5000, null],
    description:
      "Family & Friends Makeup is a makeup service for guests and family members at a wedding or celebration, as the menu says, for occasions other than your big day. It suits the bride's or groom's relatives and friends who want a professional makeup look for the event. The menu lists it at a single price with no member rate. Share your outfit, the event and the look you want with the artist, and tell them about your skin type, allergies or products that have irritated you before, so that the shades and finish can be chosen accordingly.",
  },
  {
    name: "Trial Makeup",
    category: "BRIDAL MAKEUP",
    audience: "WOMEN",
    variants: [
      ["Kryolan Trial", 2500, null],
      ["MAC Trial", 3500, null],
    ],
    description:
      "Trial Makeup lets a bride try the look before the wedding. Choose Kryolan Trial if you are considering the Kryolan bridal package, or MAC Trial if you are thinking about the MAC package. During the trial the artist applies the makeup, so you can see how the shades, finish and intensity suit you and make changes before the day. The menu prints it as Trail Makup. There is no member rate. Bring your outfit colours, jewellery and reference pictures, and mention your skin type and any allergies. Try to book the trial a few weeks ahead so there is time to adjust the look.",
  },
]

export const mehendi = [
  {
    name: "Mehendi",
    category: "MEHENDI",
    audience: "WOMEN",
    variants: [
      ["Full Arms & Half Feet", 4000, null],
      ["Half Arms", 1500, null],
      ["Full Arms", 2500, null],
      ["Half Feet", 2000, null],
      ["Arabic Style", 1500, null],
    ],
    description:
      "Mehendi is the salon's henna design service, with options by coverage: full arms and half feet, half arms, full arms, half feet, or Arabic style. Arabic style features flowing, bold floral patterns. The artist applies fresh henna paste by hand, and the colour deepens over the following day. It is popular for weddings, festivals and celebrations. There is no member rate. Bring a picture of the design you like, tell the artist about skin allergies, and allow the paste to dry fully before moving around. Avoid washing the area for several hours, and follow the aftercare advice you are given.",
  },
]

export const kids = [
  {
    name: "Kids Cut",
    category: "KIDS GROOMING",
    audience: "UNISEX",
    variants: [
      ["Fringe Cut", 300, null],
      ["U Cut", 400, 350],
      ["Layer Cut (includes Hair Wash)", 600, 550],
      ["Hair Wash (Medium)", 500, 450],
      ["Hair Wash (Long)", 800, 750],
    ],
    description:
      "Kids Cut covers haircuts and hair washing for children. The Fringe Cut is a quick fringe trim, the U Cut shapes the back into a soft U, and the Layer Cut gives layered movement and includes a hair wash. Hair Wash is offered separately for Medium and Long hair. The menu does not label Kids Cut for boys or girls, so it is shown for children of any gender. Let the stylist know if your child is nervous or sensitive, so they can be patient and keep the visit comfortable. A parent or guardian should stay with young children.",
  },
  {
    name: "Baby Cut",
    category: "KIDS GROOMING",
    audience: "UNISEX",
    price: [500, null],
    description:
      "Baby Cut is listed on the salon's premium hair-cut price list as a haircut for very young children, with no member rate. The printed menu does not give an age range or any further detail, so please ask the front desk about the age it applies to. Haircuts for babies and toddlers need patience, and the stylist will work gently and quickly. A parent or guardian should stay with the child throughout, and it helps to bring along a favourite toy or snack. Tell the stylist about any sensitivity on the scalp or skin before starting.",
  },
  {
    name: "Boy Hair Cut",
    category: "KIDS GROOMING",
    audience: "BOY",
    price: [350, null],
    description:
      "Boy Hair Cut is a standard haircut for boys, listed on the Gents & Ladies Both page with no member rate. The stylist trims and shapes the hair to the length and style you request, such as a short crop, side parting or a neat taper. Let the stylist know whether your son wants a particular style, and bring a picture if you have one. Younger boys may find it easier with a parent nearby. It is the plain haircut among the Boy services, so for colour, touch-up or other grooming see the other Boy entries on the menu.",
  },
  {
    name: "Boy Hair Beired",
    category: "KIDS GROOMING",
    audience: "BOY",
    price: [200, null],
    description:
      "Boy Hair Beired is the name exactly as printed on the Gents & Ladies Both menu page, for a boys' hair service priced at 200 with no member rate. The printed menu does not explain what Beired refers to, and the spelling may be a typo, so the name is kept as written rather than guessed. Please ask the front desk or stylist what is done in this service before booking. It is classified as a Boy service because of the BOY wording in its name. Tell the stylist about any scalp sensitivity or allergy before the service starts.",
  },
  {
    name: "Boy Hair Shiny",
    category: "KIDS GROOMING",
    audience: "BOY",
    price: [100, null],
    description:
      "Boy Hair Shiny is the name exactly as printed on the Gents & Ladies Both menu page, for a boys' hair service priced at 100 with no member rate. The name suggests a finishing service to give the hair a glossy, polished look, but the printed menu does not describe it, so please ask the stylist what is applied before booking. It is the most affordable of the Boy services. It is classified as a Boy service because of the BOY wording in its name. Tell the stylist about any scalp sensitivity or product allergy before starting.",
  },
  {
    name: "Facial Boy",
    category: "KIDS GROOMING",
    audience: "BOY",
    variants: [
      ["Basic", 1000, null],
      ["Standard", 1500, null],
      ["Premium", 2000, null],
    ],
    description:
      "Facial Boy is a facial for boys, listed on the Gents & Ladies Both page of the menu in three versions at 1,000 (marked On Words, meaning a starting price), 1,500 and 2,000. Here they are offered as Basic, Standard and Premium in order of price, so you can choose the level of facial that suits your son's skin and the time you have. A facial generally includes cleansing, gentle exfoliation, a mask and a light massage. There is no member rate. Tell the therapist about sensitive skin, breakouts or allergies beforehand, and consider staying with younger boys during the service.",
  },
  {
    name: "Boy Hair Celsius (On Words)",
    category: "KIDS GROOMING",
    audience: "BOY",
    price: [1500, null],
    description:
      "Boy Hair Celsius (On Words) is the name exactly as printed on the Gents & Ladies Both menu page, with the On Words wording indicating a starting price rather than a fixed one. It is priced at 1,500 with no member rate. The printed menu does not explain what Celsius refers to, so the name is kept as written rather than guessed. Please ask the front desk or stylist what the service involves and what the final price will be before booking. It is classified as a Boy service because of the BOY wording in its name.",
  },
  {
    name: "Boy Hair Touch Up",
    category: "KIDS GROOMING",
    audience: "BOY",
    price: [1000, null],
    description:
      "Boy Hair Touch Up is a hair colour touch-up service for boys, listed on the Gents & Ladies Both menu page with no member rate. The printed menu gives no further detail, so please ask the stylist what the touch-up covers, for example refreshing colour at the roots, and what colour products are used. Because it involves hair colour, tell the stylist about any scalp sensitivity or allergies before the service, and consider whether a parent or guardian's consent is appropriate. It is classified as a Boy service because of the BOY wording in its name.",
  },
  {
    name: "Boy Detan / Bleach",
    category: "KIDS GROOMING",
    audience: "BOY",
    variants: [
      ["Detan - Front Face", 900, null],
      ["Detan - Back Neck", 1000, null],
      ["Head Detan / Bleach", 2000, null],
      ["Leg Detan / Bleach", 2500, null],
    ],
    description:
      "Boy Detan / Bleach groups the four detan and bleach entries printed on the Gents & Ladies Both menu page right after the boys' facial entries: Detan - Front Face, Detan - Back Neck, Head Detan / Bleach and Leg Detan / Bleach. The page does not label these four lines for any audience, so they are shown here as Boy services in line with their position in the list. Each area has its own price and there is no member rate. Detan and bleach are cosmetic skin services. Tell the therapist about skin sensitivity or allergies first. Please confirm the audience with the front desk.",
  },
]

export const mens = [
  {
    name: "Moustache Color",
    category: "MEN'S GROOMING",
    audience: "MEN",
    price: [200, 180],
    description:
      "Moustache Color is a quick colouring service for the moustache, used to cover grey or to refresh the colour so it matches the hair. A small amount of colour is applied to the moustache only, left for the right amount of time and rinsed. It is a fast service, and it pairs well with Beard Coloring or a haircut. Tell the stylist about the shade you prefer, and mention any skin or hair colour sensitivity before the service so a patch test or alternative product can be considered. Avoid washing the area for a little while as the stylist advises.",
  },
  {
    name: "Beard Coloring",
    category: "MEN'S GROOMING",
    audience: "MEN",
    price: [500, 450],
    description:
      "Beard Coloring is a colouring service for the beard, used to cover grey or to give the beard an even, natural-looking shade. The colour is applied evenly through the beard, left to develop and rinsed off, so the beard looks fuller and neater. It pairs well with a trim, shave or Moustache Color. Tell the stylist the shade you want, and mention any sensitivity to hair colour or skin conditions in the beard area before the service, so that the right product can be chosen. Follow the stylist's aftercare advice on washing and moisturising the skin underneath.",
  },
  {
    name: "Light V.U. Shave",
    category: "MEN'S GROOMING",
    audience: "MEN",
    price: [1000, null],
    description:
      "Light V.U. Shave is listed at the top of the salon's premium hair-cut price list, and the name is printed exactly as V.U. Shave. It is a shaving service, classed here as a men's grooming service, and the 'Light' wording suggests a gentler shave. The printed menu does not explain what V.U. stands for, so please ask the stylist what the service includes before you book. There is no member rate. Tell the stylist about sensitive skin, razor bumps or skin conditions beforehand, and follow any aftercare advice on moisturising the skin.",
  },
]
