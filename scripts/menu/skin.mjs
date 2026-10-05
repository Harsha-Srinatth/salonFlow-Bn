// Facials, waxing, detan/bleach and threading. Prices exact from the printed menu; null member = "NA".

export const facials = [
  {
    name: "Cleanup",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    variants: [
      ["Cleanup", 700, 650],
      ["Clean Up (Acne)", 800, 750],
    ],
    description:
      "Cleanup is the salon's quick, lighter face service for a fresher look between full facials. It generally involves cleansing the skin, gentle exfoliation, a mask and a short massage so the face feels clean and refreshed. Two options are listed: the standard Cleanup and Clean Up (Acne), which is intended for skin that is prone to breakouts and is handled with that in mind. It is a good choice before an event when you have limited time, or as a regular upkeep visit. Tell your therapist about your skin type, any sensitivity and anything you are currently using on your face, so the products can be chosen accordingly.",
  },
  {
    name: "Fruit Blaster",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [1100, 1000],
    description:
      "Fruit Blaster is a revitalizing facial built around the goodness of fruit, listed in the Insta Fresh range on the menu. Fruit-based products are used to cleanse, freshen and give the face a lively, refreshed look. It is one of the lighter, more affordable facials on the menu, so it is a good starting point if you are new to salon facials or want a quick pick-me-up before an outing. The therapist will take you through the usual steps of cleansing, massage and a mask, adjusting to your skin type. Let them know if you have any allergies, particularly to fruit extracts, before the facial begins.",
  },
  {
    name: "Chocoholic",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [1300, 1200],
    description:
      "Chocoholic is a replenishing and hydrating facial that brings the luxury of chocolate into the treatment room, from the Insta Fresh range. Chocolate-based products are used to nourish and hydrate, and the facial is a pleasant, indulgent option when your skin feels dry or tired. The therapist will cleanse the face, massage and apply a mask suited to your skin type, finishing with moisturising. It sits between the lighter Fruit Blaster and the more targeted facials on the menu. If you have any allergies, particularly to cocoa or related ingredients, please tell the therapist before the service begins.",
  },
  {
    name: "Detan 100",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [1600, 1500],
    description:
      "Detan 100 is a facial that restores the skin's balance and removes tan, from the Insta Fresh range. It is a good fit after time in the sun, when the face looks dull or uneven because of tanning. The therapist uses a de-tanning routine within the facial, with cleansing, treatment products and a mask, to leave the skin looking fresher and more even. Results vary with skin type and how deep the tan is, and one facial will not undo everything. Tell the therapist about sun exposure and any skin sensitivity beforehand. A separate Detan / Bleach service is available if you only want specific areas treated.",
  },
  {
    name: "OMG Charcoal",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [2000, 1900],
    description:
      "OMG Charcoal is an activated charcoal facial from the Sensory Favourites range. According to the menu, it is designed to clear impurities and dirt from the skin, help control acne and regulate secretion from the sebaceous glands that can clog pores. In practice it combines cleansing, a charcoal treatment and a mask, and it suits oily, congested or breakout-prone skin. It is a cosmetic skincare service rather than medical acne treatment, and results vary from person to person. If you have active, painful or severe acne, check with a doctor first, and tell the therapist about any sensitivity before the facial.",
  },
  {
    name: "Gold & Glow",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [2000, 1900],
    description:
      "Gold & Glow is an exclusive facial that uses the goodness of gold to reveal a glow, as described on the menu. Gold-based products are used in the cleansing, massage and mask steps, leaving the skin looking luminous and well cared for. It is a popular choice before weddings, festivals and photographs, when you want your skin to look its radiant best. The therapist will tailor the steps to your skin type. It is priced in the middle of the facial range and appears in the Sensory Favourites group. Let the therapist know about any allergies or sensitive skin before the service, so the right products are used.",
  },
  {
    name: "HIM",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [2000, 1900],
    description:
      "HIM is a facial from the Sensory Favourites range, described on the older menu page as a facial that calms and harmonizes sensitive skin and gives a nourishing glow. The name appears on the menu without any audience label, and the printed description is shared with the Sensi Glow facial, so please ask the front desk if you would like to know how the two differ. The therapist will use soothing products designed for skin that reacts easily, with gentle cleansing, massage and a calming mask. If your skin is sensitive, tell the therapist what triggers it so the products can be chosen with care.",
  },
  {
    name: "Naturals Brightening",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [2300, 2200],
    description:
      "Naturals Brightening is a specially constructed facial regime for de-pigmenting and skin brightening, according to the menu, intended to make the skin feel soft, supple and light. It uses a series of steps with brightening-focused products to even out the look of dull or uneven skin. The therapist will cleanse, massage and apply masks suited to your skin. It is a cosmetic service, and visible results depend on your skin type and consistency of care. It is a sensible choice when your complexion looks tired or uneven. Tell the therapist about sun exposure or allergies beforehand.",
  },
  {
    name: "Dead Sea Hydration",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [2700, 2600],
    description:
      "Dead Sea Hydration is a facial in which Dead Sea mud masks work to remove impurities and dead skin, with the added benefit of special minerals to improve skin tone and elasticity, as described on the menu. It appears as Dead Hydration on an older menu page and as Dead Sea Hydration on the newer one, with the same price, so it is listed here as one service. The facial combines cleansing, a mineral mud mask and massage, leaving skin feeling clean and nourished. Tell the therapist about sensitive skin or allergies before it begins.",
  },
  {
    name: "Sensi Glow",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [2700, 2600],
    description:
      "Sensi Glow is a facial in the Skin Goals range that calms and harmonizes sensitive skin and gives a nourishing glow, according to the menu. It is chosen by people whose skin reacts easily to products, weather or stress, and who want a facial that feels gentle rather than stimulating. The therapist uses soothing products with careful cleansing, massage and a calming mask. Before the facial, tell the therapist what tends to irritate your skin, and mention any recent treatments, because that helps in choosing the right products. It is a cosmetic service and not a substitute for medical care.",
  },
  {
    name: "Naturals Age Reversal",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [2900, 2800],
    description:
      "Naturals Age Reversal is a luxurious, slow-paced facial using products rich in vitamins that soothe and brighten the skin, and the menu says it is suitable for all skin types. It is part of the Skin Goals range. The unhurried pace, with extended massage and treatment steps, makes it feel like a proper pampering session as well as a skincare service. Despite the name, it is a cosmetic facial that aims to leave skin looking fresh and radiant, not a medical anti-ageing treatment, and results vary. Tell the therapist about your skin type and any allergies beforehand.",
  },
  {
    name: "Skin Brightening",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [3000, 2900],
    description:
      "Skin Brightening is a facial that restores the balance of the skin while gently exfoliating it and leaving it with a glow, as described on the menu. It belongs to the Skin Goals range. The gentle exfoliation removes dull surface skin, and the products that follow aim to leave the complexion even and luminous. It is a good option when your skin looks flat or tired, or as preparation for an event. Results depend on your skin type and how well you look after your skin at home. Share any sensitivities with the therapist before starting.",
  },
  {
    name: "Fruity Marmalade",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [3300, 3200],
    description:
      "Fruity Marmalade is an exclusive facial that uses extracts of fruits like bearberry, grape, pineapple, kiwi and papaya to formulate a process involving nutrients, enzymes and vitamins that ensure an optimum skin glow, according to the menu. It is part of the Skin Goals range. The blend of fruit extracts gives the facial a fresh, nourishing character, and it suits skin that needs a lift. Because it uses a number of fruit extracts, please tell the therapist about any food or fruit allergies and any skin sensitivity before the treatment starts.",
  },
  {
    name: "7 Step Derma Ice",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [3900, 3800],
    description:
      "7 Step Derma Ice is a new-age cool facial that combines exotic fruits like noni, glutathione and plum, giving an instant glow and clear skin, as described on the menu. It follows a seven-step routine and includes a cooling element, which makes it refreshing as well as a treatment for the skin. It is a good pick before an event when you want your face to look bright quickly. Results are cosmetic and vary from person to person. Tell the therapist about sensitivities or allergies before it begins, particularly to fruit extracts or to cold applications.",
  },
  {
    name: "Ultimo Gold",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [4800, 4500],
    description:
      "Ultimo Gold is a luxury facial described on the menu as a revolutionary skin transformation treatment that penetrates 24 karat gold into the skin's deepest layer, accelerating cell renewal and promoting the clearance of stagnant melanin to brighten the skin. It sits in the luxury tier of facials, and is aimed at those who want a premium treatment before a special occasion. The results are cosmetic, and the experience depends on your skin type and routine. Please tell the therapist about allergies, sensitivity or any recent skin treatments before the facial starts.",
  },
  {
    name: "Beauty & Glow",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [5500, 5000],
    description:
      "Beauty & Glow is a luxury facial that uses glutathione to decrease the melanin (pigmentation) in the skin and helps decrease wrinkles and increase skin elasticity, according to the menu. It is positioned as a premium option for people who are looking at pigmentation and the look of fine lines. The treatment is a cosmetic facial, so results vary, and it is not medical treatment for pigmentation or ageing. The therapist will take you through the steps and adjust to your skin. Share any sensitivities or allergies before the facial begins.",
  },
  {
    name: "Illuminating Facial with Gojiberry",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [6500, 6000],
    description:
      "The Illuminating Facial with Gojiberry is the top of the luxury facial range. As the menu describes, it uses the extract of gojiberry, a fruit of longevity, to help balance the natural condition of the skin and protect it from external agents. The algae peel-off Goji mask has high antioxidant power, aiding skin replenishment. It is a premium facial for a special occasion or for anyone who likes an extended, indulgent experience. The effects are cosmetic and vary between people. Let the therapist know about any allergies, especially to berries or algae, before it starts.",
  },
  {
    name: "Normal Facial",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [1500, null],
    description:
      "Normal Facial is a standard facial listed on the salon's older price list, with no member rate. It follows the classic facial routine of cleansing, exfoliation, massage and a mask, then finishes with moisturising. It is a good choice when you want a traditional facial without any special product range. The printed menu does not describe the product line used, so ask your therapist what is applied. Tell them about your skin type and any allergies or sensitivities before the facial begins, so that the products and pressure can be adjusted for you.",
  },
  {
    name: "O3 Very Very Spl",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [5000, null],
    description:
      "O3 Very Very Spl is a facial listed on the salon's older price list under its printed name, with no member rate. The 'Very Very Spl' wording marks it as one of the salon's special facials and it is among the higher priced entries on that list. The menu gives no description of the steps or products, so please ask your therapist or the front desk what the service involves before booking. Typical facials include cleansing, massage and a mask, and you should tell the therapist about your skin type and any allergies before the service starts.",
  },
  {
    name: "Ladies Professional Institutions Facial",
    category: "FACIALS & SKIN CARE",
    audience: "WOMEN",
    price: [4000, null],
    description:
      "Ladies Professional Institutions Facial is listed on the salon's price list for ladies, under the wording 'Ladies Proffissional' and 'Institutions Facial', and has no member rate. The printed menu gives no further description, so please ask the front desk or your therapist what the service involves and how it differs from the other facials. It is classified here as a women's service because of the 'Ladies' wording. Tell the therapist about your skin type, sensitivities and any allergies before the facial starts, so the products and technique can be chosen to suit you.",
  },
  {
    name: "Dipigmentone Facial",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [3000, null],
    description:
      "Dipigmentone Facial is listed on the salon's price list under this exact name, with no member rate. The name points to a de-pigmenting style of facial that is aimed at the look of uneven skin tone, but the printed menu gives no description, so please ask your therapist what is used and what to expect. Facials of this kind are cosmetic services and results vary from person to person. Tell the therapist about your skin type, sun exposure and any allergies or sensitivity before the facial starts, so they can choose suitable products.",
  },
  {
    name: "Lotu's Preservative Facial",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    price: [6000, null],
    description:
      "Lotu's Preservative Facial is the highest priced facial on the older price list, with no member rate. The name suggests a skin-preserving facial, but the menu gives no further description, so please ask your therapist or the front desk what products and steps are involved before booking. As with all facials, it is a cosmetic skincare service. Tell the therapist about your skin type, any sensitivity or allergies and any recent treatments, so that the facial can be adapted to your skin and the products chosen carefully.",
  },
  {
    name: "Add On Mask",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    variants: [
      ["Rejuvenate", 500, null],
      ["Bright", 600, null],
      ["Gold", 1000, null],
    ],
    description:
      "Add On Mask lets you add an extra mask to a facial. Three masks are offered: Rejuvenate, Bright and Gold. Rejuvenate is the entry option for a refreshed look, Bright focuses on a brighter complexion, and Gold is the premium mask. The extra mask is applied during your facial, so it is booked alongside a facial rather than on its own. It is a good way to customise a facial to your skin's needs or to treat yourself before an event. Ask the therapist which mask best suits your skin type, and mention allergies or sensitivities before it is applied.",
  },
  {
    name: "Add On Skin Care - Brightening",
    category: "FACIALS & SKIN CARE",
    audience: "UNISEX",
    variants: [
      ["Neck / Elbow", 800, null],
      ["Under Eye", 1000, null],
      ["Underarm", 700, null],
    ],
    description:
      "Add On Skin Care - Brightening is an additional brightening treatment you can have for specific areas: neck and elbow, under the eyes, or underarms. These are the places where skin can look darker or uneven, and the add-on gives them targeted attention. The menu lists it as an add-on to skin care, so it is typically booked with a facial or another service, and it has no member rate. Results are cosmetic and vary from person to person. Tell the therapist about sensitive skin or allergies, especially for the delicate under-eye area, before it begins.",
  },
]

export const waxing = [
  {
    name: "Under Arms Wax - Rica (No Off)",
    category: "WAXING",
    audience: "UNISEX",
    price: [150, null],
    description:
      "Under Arms Wax using Rica wax, listed on the menu with the note 'No Off', meaning that no discount applies to this price. Rica is a well-known wax brand used for gentle hair removal, and the service removes hair from the underarm area, leaving the skin smooth. It is quick and is the more affordable of the two underarm waxing options on the menu. The salon recommends peel-off wax for sensitive areas, so mention any sensitivity, skin condition or recent irritation before the wax is applied. Have hair at a suitable length for waxing, and follow your therapist's aftercare advice.",
  },
  {
    name: "Under Arms Wax - Brazilian (No Off)",
    category: "WAXING",
    audience: "UNISEX",
    price: [200, null],
    description:
      "Under Arms Wax using Brazilian wax, listed on the menu with the note 'No Off', meaning that no discount applies to this price. Brazilian wax is a type of wax commonly used on sensitive or delicate areas, and here it is used to remove underarm hair for a smooth finish. It costs slightly more than the Rica option. Tell the therapist about sensitive skin, recent irritation or any skin condition before the service, and let them know if you have waxed the area before. Hair should be a suitable length for waxing, and your therapist will explain aftercare.",
  },
  {
    name: "Hand Wax Full",
    category: "WAXING",
    audience: "UNISEX",
    price: [900, null],
    description:
      "Hand Wax Full is a waxing service for the full hands and arms, listed on the older part of the menu with no member rate. The wax removes hair from the whole area, leaving the skin smooth. The menu also offers Liposoluble Waxing for full arms and half arms, with its own prices, so you can compare the two on the menu or ask the front desk what the difference is. Mention any sensitivity, skin condition or recent irritation to the therapist before the service starts, and follow the aftercare advice, such as avoiding heat and sun immediately afterwards.",
  },
  {
    name: "Leg Full Wax",
    category: "WAXING",
    audience: "UNISEX",
    price: [1200, null],
    description:
      "Leg Full Wax removes hair from the full legs with wax, leaving them smooth. It is listed on the older part of the menu, with no member rate. The menu also has Liposoluble Waxing options for full and half legs at different prices, so you may wish to compare them or ask the front desk how they differ. Because it is a larger area, allow enough time for the appointment. Tell the therapist about sensitive skin, varicose veins, skin conditions or recent irritation before the service, and follow the aftercare advice to keep the skin comfortable.",
  },
  {
    name: "Liposoluble Waxing",
    category: "WAXING",
    audience: "UNISEX",
    variants: [
      ["Full Arms", 540, null],
      ["Half Arms", 400, null],
      ["Full Legs", 740, null],
      ["Half Legs", 540, null],
      ["Full Waxing (FA + FL)", 1200, null],
      ["Full Back / Front", 680, null],
      ["Full Back / Midriff", 680, null],
      ["Full Body Waxing (FA + FL + FF + FB)", 2500, null],
    ],
    description:
      "Liposoluble waxing is a hair removal service using fat-soluble wax, offered by area: full arms, half arms, full legs, half legs, a full waxing package of full arms plus full legs, full back or front, full back or midriff, and full body waxing (full arms, full legs, full front and full back). Choose the option that matches the area you want, and the stylist will wax it for a smooth finish. The menu notes that full body waxing does not include the bikini area. Tell the therapist about sensitive skin or recent irritation, and follow aftercare advice. No member rate is printed.",
  },
  {
    name: "Cartridge Waxing - Full Arms & Full Legs",
    category: "WAXING",
    audience: "UNISEX",
    price: [2500, null],
    description:
      "Cartridge Waxing is a hygienic roll-on method in which wax comes in a cartridge and is applied with a roller, then removed. This service covers both full arms and full legs in one appointment. Because it uses a fresh cartridge applicator, it is chosen by many customers who prefer a neat, controlled application. The menu lists a single price for the arms and legs combination, with no member rate. Tell the therapist about sensitive skin, skin conditions or recent irritation before starting, and follow the aftercare advice to keep your skin comfortable.",
  },
  {
    name: "Peel Off Wax",
    category: "WAXING",
    audience: "UNISEX",
    variants: [
      ["Upper Lip", 150, null],
      ["Chin", 100, null],
      ["Face", 600, null],
      ["Under Arms", 250, null],
    ],
    description:
      "Peel Off Wax is a gentler waxing method where the wax sets on the skin and is peeled away, without needing a cloth strip. The menu notes that it is recommended for sensitive areas, which makes it a good option for the face and underarms. Options include upper lip, chin, face and under arms, each at its own price. Bikini peel off wax is a separate service on the menu. Choose the area you need, and the therapist will apply and remove the wax. No member rate is printed. Mention sensitivity, recent irritation or skin conditions before the service starts.",
  },
  {
    name: "Bikini Peel Off Wax",
    category: "WAXING",
    audience: "WOMEN",
    variants: [
      ["Bikini Line", 1500, null],
      ["Bikini Full", 3000, null],
    ],
    description:
      "Bikini Peel Off Wax is a waxing service for the bikini area, using peel-off wax, which the menu recommends for sensitive areas. Two options are available: Bikini Line, which tidies the edge of the bikini area, and Bikini Full, which covers the whole area. It is listed as a women's service. Your therapist will explain the process and aftercare in advance, and you should tell them about any irritation, skin conditions, allergies or recent hair removal. There is no member rate on the menu for this service. Full body waxing on the menu does not include the bikini area, so book this separately.",
  },
]

export const detan = [
  {
    name: "Detan / Bleach",
    category: "DETAN & BLEACH",
    audience: "UNISEX",
    variants: [
      ["Upper Lip", 100, 90],
      ["Underarms", 250, 225],
      ["Feet", 300, 260],
      ["Face & Neck", 500, 455],
      ["Face, Neck & Blouse Line", 700, 650],
      ["Half Arms", 600, 550],
      ["Full Arms", 800, 750],
      ["Half Legs", 800, 750],
      ["Full Legs", 1000, 900],
      ["Midriff", 500, 450],
      ["Half Back or Front", 600, 550],
      ["Full Back or Front", 700, 650],
      ["Full Body", 3300, null],
    ],
    description:
      "Detan / Bleach is an area-based service to lighten the look of tanned or darker-looking skin. Choose from upper lip, underarms, feet, face and neck, face neck and blouse line, half or full arms, half or full legs, midriff, half or full back or front, or full body. Each area has its own price, and Full Body has no member rate. The therapist applies the product to the chosen area and removes it after the right time. Tell them about sensitive skin, allergies or recent waxing or threading, because the skin can be more reactive then. Results are cosmetic and vary from person to person.",
  },
]

export const threading = [
  {
    name: "Threading",
    category: "THREADING",
    audience: "UNISEX",
    variants: [
      ["Eyebrow", 50, null],
      ["Upper Lip", 50, null],
      ["Lower Lip", 50, null],
      ["Chin", 50, null],
      ["Forehead", 50, null],
      ["Face Sides", 80, null],
      ["Full Face", 300, null],
    ],
    description:
      "Threading removes fine facial hair using a twisted cotton thread that lifts hair from the root, giving clean edges and shaping the eyebrows with precision. Choose the area you need: eyebrow, upper lip, lower lip, chin, forehead, face sides, or a full face. Each area has its own price, and the full face option covers the whole face in one visit. It is quick and needs no chemicals, but the skin can be sensitive afterwards, so avoid heavy products straight after. Tell the therapist if you have sensitive skin, a skin condition or recent irritation before starting. No member rate is printed.",
  },
]
