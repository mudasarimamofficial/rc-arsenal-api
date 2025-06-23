const express = require("express")
const cors = require("cors")
const rateLimit = require("express-rate-limit")
require("dotenv").config()

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(cors())
app.use(express.json())

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
})
app.use("/apps", limiter)

// Admin rate limiting (stricter)
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many admin requests, please try again later.",
})

// Shopify Admin API configuration
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN
const ADMIN_SECRET = process.env.ADMIN_SECRET

// Shopify API helper
async function shopifyRequest(endpoint, method = "GET", data = null) {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query: endpoint, variables: data }),
  })

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status}`)
  }

  return response.json()
}

// Helper function to calculate level from XP
function calculateLevel(xp) {
  return Math.floor(xp / 1000) + 1
}

// Helper function to get tier from level
function getTier(level) {
  if (level >= 20) return { tier: 5, text: "Legend" }
  if (level >= 15) return { tier: 4, text: "Elite" }
  if (level >= 10) return { tier: 3, text: "Veteran" }
  if (level >= 5) return { tier: 2, text: "Advanced" }
  return { tier: 1, text: "Recruit" }
}

// Routes

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "RC Arsenal API is running",
    version: "1.0.0",
    endpoints: [
      "GET /apps/killboard - Public leaderboard data",
      "GET /apps/garage-data - Customer profile data",
      "POST /apps/admin-update - Admin stats update (requires secret)",
    ],
  })
})

// GET /apps/killboard - Public leaderboard data
app.get("/apps/killboard", async (req, res) => {
  try {
    const query = `
      query getCustomers($first: Int!) {
        customers(first: $first) {
          edges {
            node {
              id
              firstName
              lastName
              email
              createdAt
              metafields(first: 20, namespace: "rc_arsenal") {
                edges {
                  node {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    `

    const response = await shopifyRequest(query, "POST", { first: 50 })

    if (response.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`)
    }

    const customers = response.data.customers.edges
    const leaderboard = []

    customers.forEach(({ node: customer }) => {
      const metafields = {}
      customer.metafields.edges.forEach(({ node: metafield }) => {
        metafields[metafield.key] = metafield.value
      })

      const xp = Number.parseInt(metafields.xp) || 0
      const level = Number.parseInt(metafields.level) || calculateLevel(xp)
      const victories = Number.parseInt(metafields.victories) || 0
      const username = metafields.username || customer.firstName || "Anonymous"
      const country = metafields.country || "Unknown"
      const faction = metafields.faction || "Independent"
      const tier = getTier(level)

      // Only include customers with some activity
      if (xp > 0 || victories > 0 || level > 1) {
        leaderboard.push({
          id: customer.id,
          username,
          xp,
          level,
          victories,
          country,
          faction,
          tier: tier.text,
          entries: victories, // Using victories as challenge entries for now
          createdAt: customer.createdAt,
        })
      }
    })

    // Sort by XP (descending)
    leaderboard.sort((a, b) => b.xp - a.xp)

    // Add ranks
    leaderboard.forEach((player, index) => {
      player.rank = index + 1
    })

    res.json({
      success: true,
      leaderboard,
      total: leaderboard.length,
      lastUpdated: new Date().toISOString(),
    })
  } catch (error) {
    console.error("Killboard error:", error)
    res.status(500).json({
      success: false,
      error: "Failed to fetch leaderboard data",
      message: error.message,
    })
  }
})

// GET /apps/garage-data - Customer profile data
app.get("/apps/garage-data", async (req, res) => {
  try {
    const customerId = req.query.customer_id

    if (!customerId) {
      return res.status(400).json({
        success: false,
        error: "customer_id parameter is required",
      })
    }

    const query = `
      query getCustomer($id: ID!) {
        customer(id: $id) {
          id
          firstName
          lastName
          email
          metafields(first: 20, namespace: "rc_arsenal") {
            edges {
              node {
                key
                value
              }
            }
          }
        }
      }
    `

    const response = await shopifyRequest(query, "POST", {
      id: `gid://shopify/Customer/${customerId}`,
    })

    if (response.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`)
    }

    const customer = response.data.customer

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: "Customer not found",
      })
    }

    const metafields = {}
    customer.metafields.edges.forEach(({ node: metafield }) => {
      metafields[metafield.key] = metafield.value
    })

    const xp = Number.parseInt(metafields.xp) || 0
    const level = Number.parseInt(metafields.level) || calculateLevel(xp)
    const victories = Number.parseInt(metafields.victories) || 0
    const tier = getTier(level)

    const garageData = {
      customer_id: customerId,
      username: metafields.username || customer.firstName || "Pilot",
      level,
      xp,
      victories,
      country: metafields.country || "Unknown",
      faction: metafields.faction || "Independent",
      tier: tier.text,
      tier_number: tier.tier,
      avatar_url: metafields.avatar_url || "",
      car_image_url: metafields.car_image_url || "",
      achievements: JSON.parse(metafields.achievements || "[]"),
      next_level_xp: level * 1000,
      xp_progress: ((xp % 1000) / 1000) * 100,
    }

    res.json({
      success: true,
      data: garageData,
      lastUpdated: new Date().toISOString(),
    })
  } catch (error) {
    console.error("Garage data error:", error)
    res.status(500).json({
      success: false,
      error: "Failed to fetch garage data",
      message: error.message,
    })
  }
})

// POST /apps/admin-update - Admin stats update (protected)
app.post("/apps/admin-update", adminLimiter, async (req, res) => {
  try {
    const { admin_secret, customer_id, updates } = req.body

    // Verify admin secret
    if (admin_secret !== ADMIN_SECRET) {
      return res.status(401).json({
        success: false,
        error: "Invalid admin secret",
      })
    }

    if (!customer_id || !updates) {
      return res.status(400).json({
        success: false,
        error: "customer_id and updates are required",
      })
    }

    // Update customer metafields
    const mutations = []

    Object.entries(updates).forEach(([key, value]) => {
      mutations.push(`
        metafield${mutations.length}: metafieldSet(metafield: {
          ownerId: "gid://shopify/Customer/${customer_id}"
          namespace: "rc_arsenal"
          key: "${key}"
          value: "${value}"
          type: "${typeof value === "number" ? "number_integer" : "single_line_text_field"}"
        }) {
          metafield {
            id
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      `)
    })

    const mutation = `
      mutation updateCustomerMetafields {
        ${mutations.join("\n")}
      }
    `

    const response = await shopifyRequest(mutation)

    if (response.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`)
    }

    // Check for user errors in the response
    const userErrors = []
    Object.values(response.data).forEach((result) => {
      if (result.userErrors && result.userErrors.length > 0) {
        userErrors.push(...result.userErrors)
      }
    })

    if (userErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Metafield update errors",
        userErrors,
      })
    }

    res.json({
      success: true,
      message: "Customer metafields updated successfully",
      customer_id,
      updates,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("Admin update error:", error)
    res.status(500).json({
      success: false,
      error: "Failed to update customer data",
      message: error.message,
    })
  }
})

// Bulk operations endpoint
app.post("/apps/admin-bulk", adminLimiter, async (req, res) => {
  try {
    const { admin_secret, operation, data } = req.body

    if (admin_secret !== ADMIN_SECRET) {
      return res.status(401).json({
        success: false,
        error: "Invalid admin secret",
      })
    }

    switch (operation) {
      case "initialize_customers":
        // Initialize all customers with default RC Arsenal metafields
        const query = `
          query getCustomers($first: Int!) {
            customers(first: $first) {
              edges {
                node {
                  id
                  firstName
                  metafields(first: 5, namespace: "rc_arsenal") {
                    edges {
                      node {
                        key
                        value
                      }
                    }
                  }
                }
              }
            }
          }
        `

        const customersResponse = await shopifyRequest(query, "POST", { first: 100 })
        const customers = customersResponse.data.customers.edges

        const initResults = []

        for (const { node: customer } of customers) {
          const existingMetafields = customer.metafields.edges.map(({ node }) => node.key)

          // Only initialize if customer doesn't have RC Arsenal data
          if (!existingMetafields.includes("level")) {
            const initMutation = `
              mutation initCustomer {
                metafield1: metafieldSet(metafield: {
                  ownerId: "${customer.id}"
                  namespace: "rc_arsenal"
                  key: "level"
                  value: "1"
                  type: "number_integer"
                }) { metafield { id } userErrors { message } }
                
                metafield2: metafieldSet(metafield: {
                  ownerId: "${customer.id}"
                  namespace: "rc_arsenal"
                  key: "xp"
                  value: "0"
                  type: "number_integer"
                }) { metafield { id } userErrors { message } }
                
                metafield3: metafieldSet(metafield: {
                  ownerId: "${customer.id}"
                  namespace: "rc_arsenal"
                  key: "victories"
                  value: "0"
                  type: "number_integer"
                }) { metafield { id } userErrors { message } }
                
                metafield4: metafieldSet(metafield: {
                  ownerId: "${customer.id}"
                  namespace: "rc_arsenal"
                  key: "tier"
                  value: "Recruit"
                  type: "single_line_text_field"
                }) { metafield { id } userErrors { message } }
                
                metafield5: metafieldSet(metafield: {
                  ownerId: "${customer.id}"
                  namespace: "rc_arsenal"
                  key: "country"
                  value: "Unknown"
                  type: "single_line_text_field"
                }) { metafield { id } userErrors { message } }
                
                metafield6: metafieldSet(metafield: {
                  ownerId: "${customer.id}"
                  namespace: "rc_arsenal"
                  key: "faction"
                  value: "Independent"
                  type: "single_line_text_field"
                }) { metafield { id } userErrors { message } }
                
                metafield7: metafieldSet(metafield: {
                  ownerId: "${customer.id}"
                  namespace: "rc_arsenal"
                  key: "username"
                  value: "${customer.firstName || "Pilot"}"
                  type: "single_line_text_field"
                }) { metafield { id } userErrors { message } }
                
                metafield8: metafieldSet(metafield: {
                  ownerId: "${customer.id}"
                  namespace: "rc_arsenal"
                  key: "achievements"
                  value: "[]"
                  type: "json"
                }) { metafield { id } userErrors { message } }
              }
            `

            const initResponse = await shopifyRequest(initMutation)
            initResults.push({
              customer_id: customer.id,
              name: customer.firstName,
              success: !initResponse.errors,
            })
          }
        }

        res.json({
          success: true,
          operation: "initialize_customers",
          results: initResults,
          total_processed: initResults.length,
        })
        break

      default:
        res.status(400).json({
          success: false,
          error: "Unknown bulk operation",
        })
    }
  } catch (error) {
    console.error("Bulk operation error:", error)
    res.status(500).json({
      success: false,
      error: "Bulk operation failed",
      message: error.message,
    })
  }
})

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error)
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message: error.message,
  })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    available_endpoints: [
      "GET /",
      "GET /apps/killboard",
      "GET /apps/garage-data",
      "POST /apps/admin-update",
      "POST /apps/admin-bulk",
    ],
  })
})

app.listen(PORT, () => {
  console.log(`🚀 RC Arsenal API server running on port ${PORT}`)
  console.log(`📊 Killboard endpoint: http://localhost:${PORT}/apps/killboard`)
  console.log(`🏠 Garage endpoint: http://localhost:${PORT}/apps/garage-data`)
  console.log(`⚙️  Admin endpoint: http://localhost:${PORT}/apps/admin-update`)
})

module.exports = app
