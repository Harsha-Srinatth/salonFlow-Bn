import PDFDocument from "pdfkit"

function toCurrency(value) {
  return `Rs ${Number(value ?? 0).toFixed(2)}`
}

export async function buildBookingInvoicePdf({ booking }) {
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 })
    const chunks = []
    doc.on("data", chunk => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    doc.fontSize(18).text("Sahasra Salon Invoice", { align: "center" })
    doc.moveDown()
    doc.text(`Customer: ${booking.customer}`)
    doc.text(`Stylist: ${booking.stylistName ?? "Not assigned"}`)
    doc.moveDown()
    doc.fontSize(11).text(`Invoice: ${booking.invoiceNumber ?? `INV-${booking.id}`}`)
    doc.text(`Booking ID: ${booking.id}`)
    doc.text(`Date/Time: ${new Date(booking.startsAt).toLocaleString()}`)
    doc.text(`Status: ${booking.status}`)
    doc.moveDown()
    doc.text("Services:")
    const services = Array.isArray(booking.services) ? booking.services : []
    if (!services.length) {
      doc.text(`- ${booking.service}`)
    } else {
      for (const item of services) {
        doc.text(`- ${item.name} (${toCurrency(item.basePrice)})`)
      }
    }
    doc.moveDown()
    doc.text(`Total duration: ${booking.durationMinutes} mins`)
    doc.text(`Total amount: ${toCurrency(booking.totalAmount)}`)
    doc.text(`Discount: ${toCurrency(booking.discountAmount)}`)
    doc.font("Helvetica-Bold").text(`Payable: ${toCurrency(booking.payableAmount)}`)
    doc.end()
  })
}
