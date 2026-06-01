import express from 'express';
import cors from 'cors';

import {
  createUser,
  authenticateUser,
  getAllUsers
} from './db';

const app = express();

app.use(cors());
app.use(express.json());

/* SIGNUP */

app.post('/api/signup', (req, res) => {
  const { first_name, last_name, email, password } = req.body;

  try {
    const result = createUser(first_name, last_name, email, password);

    if (result.success) {
      res.json({
        success: true,
        users: getAllUsers(),
        user: result.user
      });
    } else {
      res.status(400).json(result);
    }
  } catch (err: any) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* LOGIN */

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  try {
    const result = authenticateUser(email, password);

    if (result.success) {
      res.json(result);
    } else {
      res.status(401).json(result);
    }
  } catch (err: any) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* USERS */

app.get('/api/users', (req, res) => {
  res.json({
    users: getAllUsers()
  });
});

app.listen(8000, () => {
  console.log('Server running on port 8000');
});