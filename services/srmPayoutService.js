// rdsPayoutService.js
const SrmGame = require('../models/SrmGame');
const User = require('../models/User');

/**
 * Compute payouts for a Steal Ryan's Money game
 * gameId: the game's ID
 * chosenCards: the 3 chosen cards (e.g. [ {rank,suit,display}, ... ])
 * io: Socket.IO instance
 */
async function computePayouts(gameId, chosenCards, io) {
  try {
    const game = await SrmGame.findById(gameId).populate('players');
    if (!game) {
      console.log(`No game found with ID: ${gameId}`);
      return;
    }

    const bets = game.bets || [];
    const betResults = [];
    const longShotWins = []; // Track Joker (26x) and Ace (13x) wins

    // Helper to parse rank
    function parseRank(rankStr) {
      switch (rankStr) {
        case 'A': return 1;
        case 'J': return 11;
        case 'Q': return 12;
        case 'K': return 13;
        default:
          const num = parseInt(rankStr, 10);
          return isNaN(num) ? null : num;
      }
    }

    // Aces are considered high => treat rank 'A' as 14 in these bets:
    function parseRankForComparison(rankStr) {
      switch (rankStr) {
        case 'A': return 14;  // treat Ace as highest
        case 'J': return 11;
        case 'Q': return 12;
        case 'K': return 13;
        default:
          const num = parseInt(rankStr, 10);
          return isNaN(num) ? null : num; // fallback
      }
    }

    // Handy function to figure out L/M/H outcome for a single card
    // Returns: 'lowest' | 'lowest-tie' | 'middle' | 'middle-tie' | 'highest' | 'highest-tie' | 'all-tie'
    // or null if something's off.
    function getCardPosition(cardIndex, allCards) {
      const ranks = allCards.map(c => parseRankForComparison(c.rank));
      const thisRank = ranks[cardIndex];

      // If any card is a Joker => we handle that outside to force a loss
      // But we'll handle tie logic if no Joker present:

      // Count how many cards are strictly less / equal / greater than this card
      let lessCount = 0, greaterCount = 0, equalCount = 0;
      for (let i = 0; i < ranks.length; i++) {
        if (i === cardIndex) continue;
        if (thisRank > ranks[i]) lessCount++;
        else if (thisRank < ranks[i]) greaterCount++;
        else equalCount++;
      }

      // All 3 cards have the same rank => all L/M/H bets should push
      if (equalCount === 2) {
        return 'all-tie';
      }

      // Strictly highest: this card is greater than both others
      if (lessCount === 2) {
        return 'highest';
      }

      // Strictly lowest: this card is less than both others
      if (greaterCount === 2) {
        return 'lowest';
      }

      // Strictly middle: one card higher, one card lower
      if (lessCount === 1 && greaterCount === 1) {
        return 'middle';
      }

      // Tied for highest: equal to one card, greater than the other (e.g., Q-9-Q)
      if (lessCount === 1 && equalCount === 1 && greaterCount === 0) {
        return 'highest-tie';
      }

      // Tied for lowest: equal to one card, less than the other (e.g., 5-9-5)
      if (greaterCount === 1 && equalCount === 1 && lessCount === 0) {
        return 'lowest-tie';
      }

      return null;
    }

    function suitSymbolToName(symbol) {
      switch (symbol) {
        case '♠': return 'Spades';
        case '♥': return 'Hearts';
        case '♦': return 'Diamonds';
        case '♣': return 'Clubs';
        default: return symbol;
      }
    }

    function parseSpotId(spotId) {
      const cardNumber = spotId[4];
      const suffix = spotId.slice(6);

      let betDescr = suffix;
      if (suffix.startsWith('suits-')) {
        const suits = suffix.slice(6);
        betDescr = suits
          .split('')
          .map(s => suitSymbolToName(s))
          .join(' or ');
      } else if (suffix.startsWith('suit-')) {
        const suit = suffix.slice(5);
        betDescr = suitSymbolToName(suit);
      } else if (suffix.endsWith('joker')) {
        betDescr = 'Joker';
      } else if (suffix.endsWith('ace')) {
        betDescr = 'Ace';
      } else if (suffix.endsWith('odd')) {
        betDescr = 'Odd';
      } else if (suffix.endsWith('even')) {
        betDescr = 'Even';
      } else if (suffix.endsWith('low')) {
        betDescr = 'Lowest';
      } else if (suffix.endsWith('mid')) {
        betDescr = 'Middle';
      } else if (suffix.endsWith('high')) {
        betDescr = 'Highest';
      }
      return { cardNumber, betDescr };
    }

    for (const bet of bets) {
      const { userId, spotId, amount } = bet;
      let totalPayout = 0;
      let displayedResult = 0;
      const cardIndex = parseInt(spotId.charAt(4), 10) - 1;
      const chosenCard = chosenCards[cardIndex];

      // Track if this bet is a long shot win
      let isLongShotWin = null;

      if (!chosenCard) {
        // No card => no payout
        totalPayout = 0;
      }
      // L/M/H bets - handle BEFORE Joker check since L/M/H considers all 3 cards
      else if (spotId.endsWith('-low') || spotId.endsWith('-mid') || spotId.endsWith('-high')) {
        // If there's any joker among chosenCards => all L/M/H bets lose
        const anyJoker = chosenCards.some(c => c.isJoker);
        if (anyJoker) {
          totalPayout = 0; // Joker present => L/M/H bets lose
        } else {
          // Determine the position of this card
          const position = getCardPosition(cardIndex, chosenCards);

          // If position is null => something odd, no payout
          if (!position) {
            totalPayout = 0;
          } else if (position === 'all-tie') {
            // All 3 cards have the same rank => all L/M/H bets push
            totalPayout = amount;
          } else {
            // Are we betting on 'low', 'mid', or 'high'?
            const isBetLow = spotId.endsWith('-low');
            const isBetMid = spotId.endsWith('-mid');
            const isBetHigh = spotId.endsWith('-high');

            // Check if it's a tie or a strict outcome
            if (position.startsWith('lowest') && isBetLow) {
              // 'lowest' or 'lowest-tie'
              if (position === 'lowest') {
                totalPayout = 3 * amount; // correct distinct outcome => 3× stake
              } else {
                totalPayout = amount;     // tie => push
              }
            } 
            else if (position.startsWith('middle') && isBetMid) {
              if (position === 'middle') {
                totalPayout = 3 * amount;
              } else {
                totalPayout = amount; // tie => push
              }
            }
            else if (position.startsWith('highest') && isBetHigh) {
              if (position === 'highest') {
                totalPayout = 3 * amount;
              } else {
                totalPayout = amount; // tie => push
              }
            }
            else {
              // Not the correct position => lose
              totalPayout = 0;
            }
          }
        }
      }
      else if (chosenCard.isJoker) {
        // If it's a Joker
        if (spotId.endsWith('-joker')) {
          // Pay out 26× stake (2 jokers out of 52 odds).
          totalPayout = 26 * amount;
          isLongShotWin = { type: 'joker', multiplier: 26 };
        } else {
          // They didn't bet on the Joker => lose
          totalPayout = 0;
        }
      } 
      else if (spotId.includes('suits-')) {
        // two-suit logic
        const suitsStr = spotId.split('suits-')[1]; 
        const suitsArray = suitsStr.split('');
        if (suitsArray.includes(chosenCard.suit)) {
          // You pay 2× stake if you want net = +1 on a 1 stake 
          // i.e. totalPayout = 2
          totalPayout = 2 * amount;
        }
      } 
      else if (spotId.includes('suit-')) {
        // single-suit logic
        const suitSymbol = spotId.slice(-1);
        if (chosenCard.suit === suitSymbol) {
          // single suit is 4× total if we want a 3 profit on a stake of 1
          totalPayout = 4 * amount;
        }
      }
      else if (spotId.endsWith('-odd') || spotId.endsWith('-even')) {
        // Odd/Even
        const numericRank = parseRank(chosenCard.rank);
        if (numericRank !== null) {
          const isOdd = (numericRank % 2 !== 0);
          const playerChoseOdd = spotId.endsWith('-odd');
          if ((isOdd && playerChoseOdd) || (!isOdd && !playerChoseOdd)) {
            // Suppose you want 2× total, so user's net is +1 if stake=1
            totalPayout = 2 * amount;
          }
        }
      }
      else if (spotId.endsWith('-ace')) {
        const numericRank = parseRank(chosenCard.rank);
        if (numericRank === 1) {
          totalPayout = 13 * amount;
          isLongShotWin = { type: 'ace', multiplier: 13 };
        }
      }

      displayedResult = totalPayout - amount;

      const { cardNumber, betDescr } = parseSpotId(spotId);

      // Fetch the user once, to display username and potentially update tickets
      let userDoc;
      try {
        userDoc = await User.findById(userId);
      } catch (err) {
        console.error('Error finding user for betResults:', err);
      }

      // If no userDoc is found, we'll still record UnknownUser
      const userNameForDisplay = userDoc ? userDoc.username : 'UnknownUser';

      betResults.push({
        userId: userId.toString(),
        username: userNameForDisplay,
        cardNumber,
        betDescr,
        wager: amount,
        net: displayedResult,
      });

      // If this was a long shot win, add to the list for celebration
      if (isLongShotWin && totalPayout > 0) {
        // Get the user's color from the game's players array
        const playerInfo = game.players.find(
          p => p._id.toString() === userId.toString()
        );
        const userColor = playerInfo?.color || '#d4af37';

        longShotWins.push({
          type: isLongShotWin.type,
          winnerId: userId.toString(),
          winnerName: userNameForDisplay,
          winnerColor: userColor,
          cardNumber: parseInt(cardNumber, 10),
          wager: amount,
          payout: totalPayout,
          multiplier: isLongShotWin.multiplier,
        });
      }

      // Now update tickets if totalPayout > 0
      if (userDoc && totalPayout > 0) {
        try {
          const reason = `Steal Ryan's Money - Game #${game.code}`;
          await userDoc.addTickets(totalPayout, reason);

          io.emit('ticketUpdate', {
            userId: userDoc._id,
            username: userDoc.username,
            ticketBalance: userDoc.ticketBalance,
          });
        } catch (err) {
          console.error('Error updating user tickets:', err);
        }
      }
    }

    // Emit long shot win events for celebrations (before results modal)
    if (longShotWins.length > 0) {
      console.log(`Long shot wins detected: ${longShotWins.length}`);
      io.to(`srmGame_${gameId}`).emit('longShotWins', longShotWins);
    }

    // Send final results to game room
    io.to(`srmGame_${gameId}`).emit('payoutResults', betResults);

    console.log('Payouts computed successfully.');
  } catch (error) {
    console.error('Error computing payouts:', error);
  }
}

module.exports = { computePayouts };